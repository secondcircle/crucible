// @vitest-environment node
//
// Electron and the shell are both stand-ins here: the shell's own behavior is
// tested where it lives, and what is left is plumbing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { EVENT_CHANNEL, REQUEST_CHANNEL, type PortResult } from '../../shared/agent/channels'
import type { PortEvent, PortEventListener } from '../../shared/agent/port'
import type { Shell } from '../shell/shell'
import { serveAgentChannel } from './channel'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (invocation: unknown, ...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle(channel: string, handler: (invocation: unknown, ...args: unknown[]) => unknown) {
      // Electron refuses a second handler for one channel; so does this.
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
  readonly sent: readonly PortEvent[]
  /** A new document: a reload, or any cross-document navigation. */
  reload(): void
  /** A same-document navigation: a fragment, a `pushState`. */
  navigateInPlace(): void
  close(): void
}

function stubWindow(): StubWindow {
  const sent: PortEvent[] = []
  const navigations: Array<(details: { isMainFrame: boolean; isSameDocument: boolean }) => void> = []
  const closes: Array<() => void> = []
  let destroyed = false

  const window = {
    webContents: {
      isDestroyed: () => destroyed,
      send: (channel: string, event: PortEvent) => {
        expect(channel).toBe(EVENT_CHANNEL)
        sent.push(event)
      },
      on: (
        event: string,
        listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void
      ) => {
        expect(event).toBe('did-start-navigation')
        navigations.push(listener)
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
    reload: () => {
      for (const navigate of navigations) navigate({ isMainFrame: true, isSameDocument: false })
    },
    navigateInPlace: () => {
      for (const navigate of navigations) navigate({ isMainFrame: true, isSameDocument: true })
    },
    close: () => {
      destroyed = true
      for (const closed of closes) closed()
    }
  }
}

function stubShell(answers: Partial<Record<string, unknown>> = {}): {
  shell: Shell
  asked: Array<{ op: string; args: unknown[] }>
  emit: (event: PortEvent) => void
  disposals: number
} {
  const asked: Array<{ op: string; args: unknown[] }> = []
  const listeners = new Set<PortEventListener>()
  const record = { disposals: 0 }

  function op(name: string) {
    return async (...args: unknown[]): Promise<unknown> => {
      asked.push({ op: name, args })
      const answer = answers[name]
      if (answer instanceof Error) throw answer
      return answer
    }
  }

  const shell = {
    snapshot: op('snapshot'),
    onEvent: (listener: PortEventListener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    addWorkspace: op('addWorkspace'),
    activateWorkspace: op('activateWorkspace'),
    removeWorkspace: op('removeWorkspace'),
    createSession: op('createSession'),
    activateSession: op('activateSession'),
    removeSession: op('removeSession'),
    resetSession: op('resetSession'),
    transcript: op('transcript'),
    searchHistory: op('searchHistory'),
    resumeSession: op('resumeSession'),
    listModels: op('listModels'),
    setModel: op('setModel'),
    setThinkingLevel: op('setThinkingLevel'),
    prompt: op('prompt'),
    cancel: op('cancel'),
    dispose: () => {
      record.disposals += 1
    }
  } as unknown as Shell

  return {
    shell,
    asked,
    emit: (event: PortEvent) => {
      for (const listener of listeners) listener(event)
    },
    get disposals() {
      return record.disposals
    }
  }
}

async function request(op: string, ...args: unknown[]): Promise<PortResult> {
  const handler = electron.handlers.get(REQUEST_CHANNEL)
  if (handler === undefined) throw new Error('nothing is serving the request channel')
  return (await handler({}, { op, args })) as PortResult
}

beforeEach(() => {
  electron.handlers.clear()
})

afterEach(() => {
  electron.handlers.clear()
})

describe('what crosses the request channel', () => {
  it('reaches the operation the request names, with its arguments', async () => {
    const stub = stubShell({ prompt: 't-1' })
    serveAgentChannel(stub.shell, stubWindow().window)

    const answer = await request('prompt', 'session-1', 'hello')

    expect(answer).toEqual({ ok: true, value: 't-1' })
    expect(stub.asked).toEqual([{ op: 'prompt', args: ['session-1', 'hello'] }])
  })

  it('answers a refusal with the sentence main wrote, not with an IPC wrapper', async () => {
    const stub = stubShell({ prompt: new Error('That session is already working.') })
    serveAgentChannel(stub.shell, stubWindow().window)

    const answer = await request('prompt', 'session-1', 'hello')

    expect(answer).toEqual({ ok: false, message: 'That session is already working.' })
  })

  it('refuses an operation it does not serve, and one whose payload is wrong', async () => {
    const stub = stubShell()
    serveAgentChannel(stub.shell, stubWindow().window)

    expect(await request('deleteEverything', 'now')).toEqual({
      ok: false,
      message: 'Crucible was asked for something it does not do.'
    })
    expect(await request('activateSession', 42)).toMatchObject({ ok: false })
    expect(stub.asked).toEqual([])
  })

  it('serves the operations that take no argument at all', async () => {
    const stub = stubShell({ snapshot: { workspaces: [], sessions: [] }, addWorkspace: null })
    serveAgentChannel(stub.shell, stubWindow().window)

    expect(await request('snapshot')).toEqual({ ok: true, value: { workspaces: [], sessions: [] } })
    expect(await request('addWorkspace')).toEqual({ ok: true, value: null })
  })
})

describe('what crosses the event channel', () => {
  it('is every port event, unchanged', async () => {
    const stub = stubShell()
    const window = stubWindow()
    serveAgentChannel(stub.shell, window.window)

    stub.emit({ type: 'turn_started', sessionId: 's', turnId: 't-1' })
    stub.emit({ type: 'text_delta', sessionId: 's', turnId: 't-1', delta: 'hi' })

    expect(window.sent).toEqual([
      { type: 'turn_started', sessionId: 's', turnId: 't-1' },
      { type: 'text_delta', sessionId: 's', turnId: 't-1', delta: 'hi' }
    ])
  })

  it('stops at a closed window rather than sending into it', () => {
    const stub = stubShell()
    const window = stubWindow()
    serveAgentChannel(stub.shell, window.window)

    window.close()
    stub.emit({ type: 'turn_ended', sessionId: 's', turnId: 't-1' })

    expect(window.sent).toEqual([])
  })
})

describe('a document going away', () => {
  it('abandons the work on a cross-document navigation and keeps serving', async () => {
    const stub = stubShell({ prompt: 't-2' })
    const window = stubWindow()
    serveAgentChannel(stub.shell, window.window)

    window.reload()

    expect(stub.disposals).toBe(1)
    expect(await request('prompt', 's', 'again')).toEqual({ ok: true, value: 't-2' })
  })

  it('leaves a same-document navigation alone', () => {
    const stub = stubShell()
    const window = stubWindow()
    serveAgentChannel(stub.shell, window.window)

    window.navigateInPlace()

    expect(stub.disposals).toBe(0)
  })

  it('unregisters the handler when the window closes, so the next window may serve', () => {
    const stub = stubShell()
    const window = stubWindow()
    serveAgentChannel(stub.shell, window.window)

    window.close()

    expect(electron.handlers.has(REQUEST_CHANNEL)).toBe(false)
    expect(() => serveAgentChannel(stubShell().shell, stubWindow().window)).not.toThrow()
  })

  it('disposes once however many times it is asked to', () => {
    const stub = stubShell()
    const window = stubWindow()
    const channel = serveAgentChannel(stub.shell, window.window)

    channel.dispose()
    channel.dispose()

    expect(stub.disposals).toBe(1)
  })
})
