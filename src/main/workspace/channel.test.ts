// @vitest-environment node
//
// Electron and the service are both stand-ins here: what the service means is
// tested where it lives, and what is left is plumbing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import {
  WORKSPACE_EVENT_CHANNEL,
  WORKSPACE_REQUEST_CHANNEL,
  type WorkspaceResult
} from '../../shared/workspace/channels'
import type {
  WorkspaceEvent,
  WorkspaceEventListener,
  WorkspaceService
} from '../../shared/workspace/service'
import { serveWorkspaceChannel } from './channel'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (invocation: unknown, ...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle(channel: string, handler: (invocation: unknown, ...args: unknown[]) => unknown) {
      if (electron.handlers.has(channel)) throw new Error(`second handler for ${channel}`)
      electron.handlers.set(channel, handler)
    },
    removeHandler(channel: string) {
      electron.handlers.delete(channel)
    }
  }
}))

interface StubWindow {
  readonly window: BrowserWindow
  readonly sent: readonly WorkspaceEvent[]
  close(): void
}

function stubWindow(): StubWindow {
  const sent: WorkspaceEvent[] = []
  const closes: Array<() => void> = []
  let destroyed = false

  const window = {
    webContents: {
      isDestroyed: () => destroyed,
      send: (channel: string, event: WorkspaceEvent) => {
        expect(channel).toBe(WORKSPACE_EVENT_CHANNEL)
        sent.push(event)
      }
    },
    on: (event: string, listener: () => void) => {
      expect(event).toBe('closed')
      closes.push(listener)
    }
  }

  return {
    window: window as unknown as BrowserWindow,
    sent,
    close: () => {
      destroyed = true
      for (const closed of closes) closed()
    }
  }
}

interface StubService {
  readonly service: WorkspaceService
  readonly asked: ReadonlyArray<{ readonly op: string; readonly args: readonly unknown[] }>
  emit(event: WorkspaceEvent): void
}

function stubService(): StubService {
  const asked: Array<{ op: string; args: readonly unknown[] }> = []
  const listeners = new Set<WorkspaceEventListener>()

  const service: WorkspaceService = {
    async searchFiles(workspacePath: string, query: string) {
      asked.push({ op: 'searchFiles', args: [workspacePath, query] })
      if (query === 'refuse me') throw new Error('That folder could not be read.')
      return ['src/shared/workspace/service.ts']
    },
    async isGitWorkspace(workspacePath: string) {
      asked.push({ op: 'isGitWorkspace', args: [workspacePath] })
      return workspacePath !== '/tmp/not-a-repo'
    },
    async createWorktree(workspacePath: string) {
      asked.push({ op: 'createWorktree', args: [workspacePath] })
      return {
        ok: true as const,
        path: `${workspacePath}/.crucible/worktrees/9f3a2c`,
        branch: 'crucible/9f3a2c'
      }
    },
    async startRun(workspacePath: string, command: string) {
      asked.push({ op: 'startRun', args: [workspacePath, command] })
      return 'run-1'
    },
    async stopRun(runId: string) {
      asked.push({ op: 'stopRun', args: [runId] })
    },
    onEvent(listener: WorkspaceEventListener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }

  return {
    service,
    asked,
    emit: (event) => {
      for (const listener of listeners) listener(event)
    }
  }
}

async function request(payload: unknown): Promise<WorkspaceResult> {
  const handler = electron.handlers.get(WORKSPACE_REQUEST_CHANNEL)
  if (handler === undefined) throw new Error('nothing is serving the workspace channel')
  return (await handler({}, payload)) as WorkspaceResult
}

let stub: StubService
let host: StubWindow

beforeEach(() => {
  electron.handlers.clear()
  stub = stubService()
  host = stubWindow()
  serveWorkspaceChannel(stub.service, host.window)
})

afterEach(() => {
  electron.handlers.clear()
})

describe('what crosses the workspace channel', () => {
  it('reaches the operation the request names, with its arguments', async () => {
    const answer = await request({ op: 'searchFiles', args: ['/repos/crucible', 'port'] })

    expect(answer).toEqual({ ok: true, value: ['src/shared/workspace/service.ts'] })
    expect(stub.asked).toEqual([{ op: 'searchFiles', args: ['/repos/crucible', 'port'] }])
  })

  it('starts and stops a run by the id the service minted', async () => {
    const started = await request({ op: 'startRun', args: ['/repos/crucible', 'git status'] })
    expect(started).toEqual({ ok: true, value: 'run-1' })

    await request({ op: 'stopRun', args: ['run-1'] })
    expect(stub.asked.at(-1)).toEqual({ op: 'stopRun', args: ['run-1'] })
  })

  it('carries the worktree questions across, answers and all', async () => {
    expect(await request({ op: 'isGitWorkspace', args: ['/repos/crucible'] })).toEqual({
      ok: true,
      value: true
    })
    expect(await request({ op: 'isGitWorkspace', args: ['/tmp/not-a-repo'] })).toEqual({
      ok: true,
      value: false
    })
    expect(await request({ op: 'createWorktree', args: ['/repos/crucible'] })).toEqual({
      ok: true,
      value: {
        ok: true,
        path: '/repos/crucible/.crucible/worktrees/9f3a2c',
        branch: 'crucible/9f3a2c'
      }
    })
  })

  it('answers a refusal as a value, with the sentence written for a person', async () => {
    const answer = await request({ op: 'searchFiles', args: ['/repos/crucible', 'refuse me'] })

    expect(answer).toEqual({ ok: false, message: 'That folder could not be read.' })
  })

  it('refuses an operation it does not have', async () => {
    const answer = await request({ op: 'deleteEverything', args: [] })

    expect(answer).toEqual({
      ok: false,
      message: 'Crucible was asked for something its workspace service does not do.'
    })
  })

  it('refuses a request that is not one', async () => {
    expect(await request(null)).toMatchObject({ ok: false })
    expect(await request({ args: [] })).toMatchObject({ ok: false })
    expect(await request({ op: 'stopRun', args: [7] })).toMatchObject({ ok: false })
  })

  it('forwards every event the service produced to the window', () => {
    stub.emit({ type: 'run_output', runId: 'run-1', chunk: 'hello\n' })
    stub.emit({ type: 'run_ended', runId: 'run-1', exitCode: 0 })

    expect(host.sent).toEqual([
      { type: 'run_output', runId: 'run-1', chunk: 'hello\n' },
      { type: 'run_ended', runId: 'run-1', exitCode: 0 }
    ])
  })

  it('stops serving when the window closes', () => {
    host.close()

    expect(electron.handlers.has(WORKSPACE_REQUEST_CHANNEL)).toBe(false)
    stub.emit({ type: 'run_output', runId: 'run-1', chunk: 'too late\n' })
    expect(host.sent).toEqual([])
  })
})
