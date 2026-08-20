// @vitest-environment jsdom
//
// The preload surface is a stand-in, because this side of the boundary is all a
// document can see.
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceRequest, WorkspaceResult } from '../../../shared/workspace/channels'
import type { WorkspaceEvent } from '../../../shared/workspace/service'
import { createWorkspaceClient } from './ipc-client'

interface Surface {
  readonly requests: WorkspaceRequest[]
  emit(event: WorkspaceEvent): void
}

function install(answer: (request: WorkspaceRequest) => WorkspaceResult): Surface {
  const requests: WorkspaceRequest[] = []
  const listeners = new Set<(event: WorkspaceEvent) => void>()

  window.crucible = {
    workspace: {
      request: async (request: WorkspaceRequest) => {
        requests.push(request)
        return answer(request)
      },
      onEvent: (listener: (event: WorkspaceEvent) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  }

  return {
    requests,
    emit: (event) => {
      for (const listener of listeners) listener(event)
    }
  }
}

afterEach(() => {
  delete window.crucible
})

describe('the workspace client', () => {
  it('carries an operation across as one named request', async () => {
    const surface = install(() => ({ ok: true, value: ['package.json'] }))
    const service = createWorkspaceClient()

    await expect(service.searchFiles('/repos/crucible', 'pack')).resolves.toEqual([
      'package.json'
    ])
    expect(surface.requests).toEqual([
      { op: 'searchFiles', args: ['/repos/crucible', 'pack'] }
    ])
  })

  it('turns a refused result back into a rejection a person can read', async () => {
    install(() => ({ ok: false, message: 'That folder could not be read.' }))
    const service = createWorkspaceClient()

    await expect(service.startRun('/repos/crucible', 'ls')).rejects.toThrow(
      'That folder could not be read.'
    )
  })

  it('delivers events to every listener, and stops on unsubscribe', () => {
    const surface = install(() => ({ ok: true, value: null }))
    const service = createWorkspaceClient()
    const heard: WorkspaceEvent[] = []
    const stop = service.onEvent((event) => heard.push(event))

    surface.emit({ type: 'run_output', runId: 'run-1', chunk: 'hello\n' })
    stop()
    surface.emit({ type: 'run_ended', runId: 'run-1', exitCode: 0 })

    expect(heard).toEqual([{ type: 'run_output', runId: 'run-1', chunk: 'hello\n' }])
  })

  it('says so plainly when the preload did not load', () => {
    expect(() => createWorkspaceClient()).toThrow(/preload did not load/)
  })
})
