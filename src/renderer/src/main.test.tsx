// @vitest-environment jsdom
//
// The entry point is imported for effect, because loading it is the whole of
// what it offers a caller.
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortRequest, PortResult } from '../../shared/agent/channels'
import type { PortEvent } from '../../shared/agent/port'
import type { CommandRequest, CommandResult } from '../../shared/commands/channels'
import type { WorkspaceRequest, WorkspaceResult } from '../../shared/workspace/channels'
import type { WorkspaceEvent } from '../../shared/workspace/service'
import { createScriptedCommands, type ScriptedCommands } from './testing/scripted-commands'
import { sessionsShown } from './testing/sidebar'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace, type ScriptedWorkspace } from './testing/scripted-workspace'

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
 * Failures become `{ ok: false }` values exactly as the channels answer them,
 * so nothing here refuses in a way the real surface could not.
 */
function pageWithPreload(
  port: ScriptedPort,
  workspace: ScriptedWorkspace = createScriptedWorkspace(),
  commands: ScriptedCommands = createScriptedCommands()
): void {
  async function answer(
    on: object,
    request: PortRequest | WorkspaceRequest | CommandRequest
  ): Promise<PortResult> {
    try {
      return { ok: true, value: await dispatch(on as ScriptedPort, request) }
    } catch (cause) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : 'the stand-in refused'
      }
    }
  }

  // Defined rather than assigned: naming that property is the one thing the
  // import fence forbids the renderer, and this stands in for the preload.
  Object.defineProperty(window, 'crucible', {
    value: {
      agent: {
        request: (request: PortRequest): Promise<PortResult> => answer(port, request),
        onEvent: (listener: (event: PortEvent) => void): (() => void) => port.onEvent(listener)
      },
      workspace: {
        request: (request: WorkspaceRequest): Promise<WorkspaceResult> =>
          answer(workspace, request),
        onEvent: (listener: (event: WorkspaceEvent) => void): (() => void) =>
          workspace.onEvent(listener)
      },
      commands: {
        request: (request: CommandRequest): Promise<CommandResult> => answer(commands, request)
      },
      // A dev launch's answer: never an update, so the pill stays absent.
      appUpdate: {
        request: async (): Promise<{ ok: true; value: null }> => ({ ok: true, value: null }),
        onEvent: (): (() => void) => () => {}
      },
      // Nothing cached and nothing to fetch, so the strip renders no block.
      quota: {
        request: async (): Promise<{ ok: true; value: unknown }> => ({
          ok: true,
          value: { providers: {}, fetchedAt: Date.now() }
        }),
        onEvent: (): (() => void) => () => {}
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

    // Nothing here handed the renderer a port, so a seeded workspace and
    // session on screen mean the snapshot crossed the preload surface.
    await sessionsShown()
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
