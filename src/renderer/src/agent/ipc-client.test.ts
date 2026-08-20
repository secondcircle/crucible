// @vitest-environment jsdom
//
// The preload surface is a stand-in, because this side of the boundary is all a
// document can see.
import { afterEach, describe, expect, it } from 'vitest'
import type { PortRequest, PortResult } from '../../../shared/agent/channels'
import type { PortEvent } from '../../../shared/agent/port'
import { createIpcClient } from './ipc-client'

interface Surface {
  readonly requests: PortRequest[]
  emit(event: PortEvent): void
}

function install(answer: (request: PortRequest) => PortResult): Surface {
  const requests: PortRequest[] = []
  const listeners = new Set<(event: PortEvent) => void>()

  window.crucible = {
    agent: {
      request: async (request: PortRequest) => {
        requests.push(request)
        return answer(request)
      },
      onEvent: (listener: (event: PortEvent) => void) => {
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

describe('an operation', () => {
  it('crosses as one named request and comes back as its value', async () => {
    const surface = install(() => ({ ok: true, value: 't-1' }))
    const port = createIpcClient()

    await expect(port.prompt('session-1', 'hello')).resolves.toBe('t-1')
    expect(surface.requests).toEqual([{ op: 'prompt', args: ['session-1', 'hello'] }])
  })

  it('carries no arguments when it has none', async () => {
    const surface = install(() => ({ ok: true, value: null }))
    const port = createIpcClient()

    await port.addWorkspace()

    expect(surface.requests).toEqual([{ op: 'addWorkspace', args: [] }])
  })

  it('sends the panel operations by their port names, and brings the body back', async () => {
    const surface = install((request) =>
      request.op === 'exhibit'
        ? { ok: true, value: { body: '# the plan' } }
        : { ok: true, value: undefined }
    )
    const port = createIpcClient()

    await port.activateTab('session-1', 'plan')
    await port.closeTab('session-1', 'report')
    await expect(port.exhibit('session-1', 'plan')).resolves.toEqual({ body: '# the plan' })

    expect(surface.requests).toEqual([
      { op: 'activateTab', args: ['session-1', 'plan'] },
      { op: 'closeTab', args: ['session-1', 'report'] },
      { op: 'exhibit', args: ['session-1', 'plan'] }
    ])
  })

  it('becomes a rejection carrying main\u2019s own sentence when it is refused', async () => {
    install(() => ({ ok: false, message: 'That session is already working.' }))
    const port = createIpcClient()

    await expect(port.prompt('session-1', 'hello')).rejects.toThrow(
      'That session is already working.'
    )
  })
})

describe('events', () => {
  it('reach every listener, and stop reaching one that unsubscribed', () => {
    const surface = install(() => ({ ok: true, value: undefined }))
    const port = createIpcClient()
    const first: PortEvent[] = []
    const second: PortEvent[] = []
    port.onEvent((event) => first.push(event))
    const stop = port.onEvent((event) => second.push(event))

    surface.emit({ type: 'turn_started', sessionId: 's', turnId: 't-1' })
    stop()
    surface.emit({ type: 'turn_ended', sessionId: 's', turnId: 't-1' })

    expect(first.map((event) => event.type)).toEqual(['turn_started', 'turn_ended'])
    expect(second.map((event) => event.type)).toEqual(['turn_started'])
  })
})

describe('a preload that did not load', () => {
  it('fails at once, with the one sentence that explains it', () => {
    delete window.crucible

    expect(() => createIpcClient()).toThrow(/window.crucible is missing/)
  })
})
