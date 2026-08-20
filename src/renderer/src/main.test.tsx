// @vitest-environment jsdom
//
// The renderer's entry point is a module whose interface is what it does when
// the browser loads it: it finds `#root` in the document the app ships and
// mounts the shell there against the port it builds — the IPC client, always,
// because the app has one path to an agent and it is the shipped one. So the
// test loads it the way `index.html` does — import for effect, into a document
// with the same `#root` — and asserts on what a person then sees.
//
// What stands in for main is the preload surface: `request`/`onEvent` over a
// scripted port, dispatched by operation name exactly as main's channel does —
// the op *is* the port method's name (channels.ts), so the stand-in needs no
// second vocabulary either. It is installed with `Object.defineProperty`
// rather than by assigning `window.crucible`: naming that property is the one
// thing the import fence forbids the renderer, and this test is standing in
// for the preload, not reaching past it.
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortRequest, PortResult } from '../../shared/agent/channels'
import type { PortEvent } from '../../shared/agent/port'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'

const MODEL = {
  id: 'fake/deterministic',
  label: 'Fake · deterministic',
  thinkingLevels: ['off', 'low'] as const
}

/** `index.html` is the module's real environment: one empty `#root`. */
function pageWithRoot(): void {
  document.body.innerHTML = '<div id="root"></div>'
}

/**
 * One operation, dispatched the way main's channel dispatches it: by the
 * port method's own name. An unknown op is a refusal, not undefined behavior.
 */
function dispatch(port: ScriptedPort, { op, args }: PortRequest): Promise<unknown> {
  const methods = port as unknown as Record<string, (...given: unknown[]) => Promise<unknown>>
  const method = methods[op]
  if (typeof method !== 'function') {
    throw new Error(`the preload stand-in was asked for ${op}, which no port serves`)
  }
  return method.apply(port, [...args])
}

/**
 * The preload surface a launched window has, over the port main would serve.
 * Failures become `{ ok: false }` values exactly as the channel answers them.
 */
function pageWithPreload(port: ScriptedPort): void {
  Object.defineProperty(window, 'crucible', {
    value: {
      agent: {
        request: async (request: PortRequest): Promise<PortResult> => {
          try {
            return { ok: true, value: await dispatch(port, request) }
          } catch (cause) {
            return {
              ok: false,
              message: cause instanceof Error ? cause.message : 'the stand-in refused'
            }
          }
        },
        onEvent: (listener: (event: PortEvent) => void): (() => void) => port.onEvent(listener)
      }
    },
    configurable: true
  })
}

/** Loads the entry point for effect, as a script tag would. */
async function launch(): Promise<void> {
  await act(async () => {
    await import('./main')
  })
}

beforeEach(() => {
  vi.resetModules()
  document.body.innerHTML = ''
})

afterEach(() => {
  // The entry point mounted its own React root, which testing-library's
  // cleanup does not know about; dropping the document is the unmount.
  document.body.innerHTML = ''
  Reflect.deleteProperty(window, 'crucible')
})

describe('the renderer entry point', () => {
  it('mounts the shell on #root against the port it builds', async () => {
    const port = createScriptedPort(oneSession({ model: MODEL.id, thinkingLevel: 'off' }))
    port.models = [MODEL]
    pageWithRoot()
    pageWithPreload(port)

    await launch()

    // What launched is the shell over the stand-in's snapshot: the seeded
    // workspace and session are on screen, so the snapshot crossed the
    // preload surface — nothing in this test handed the renderer a port.
    await screen.findByRole('button', { name: /^Session · / })
    expect(screen.getByRole('button', { name: 'crucible' })).toBeInTheDocument()

    // The request path: what is typed here reaches the port as a prompt.
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'Hello agent' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await vi.waitFor(() => {
      expect(port.calls.some((call) => call.op === 'prompt')).toBe(true)
    })
    expect(port.calls.find((call) => call.op === 'prompt')?.args).toEqual(['s1', 'Hello agent'])

    // The event path: what the port streams reaches the transcript.
    act(() => {
      port.text('s1', 'Hello back from the stand-in.')
      port.endTurn('s1')
    })
    expect(await screen.findByText('Hello back from the stand-in.')).toBeInTheDocument()
  })

  it('refuses to launch into a document without #root', async () => {
    pageWithPreload(createScriptedPort())

    await expect(import('./main')).rejects.toThrow('renderer: #root is missing from index.html')
    expect(document.body.innerHTML).toBe('')
  })

  it('refuses to launch when the preload surface is missing', async () => {
    pageWithRoot()

    await expect(import('./main')).rejects.toThrow('window.crucible is missing')
  })
})
