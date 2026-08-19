import { ipcMain, type BrowserWindow } from 'electron'
import { EVENT_CHANNEL, REQUEST_CHANNEL, type PortResult } from '../../shared/agent/channels'
import type { PortEvent } from '../../shared/agent/port'
import type { Shell } from '../shell/shell'
import { displaySafeMessage } from './adapter-error'

/**
 * Main's half of the agent channel: the shell, served over two IPC channels for
 * the lifetime of one window.
 *
 * It is plumbing and nothing else. Every rule about turns, guards, ordering and
 * cancellation lives in the shell (ADR 0003), which is what lets that whole
 * body of behavior be tested in plain node without Electron anywhere near it.
 * What is left here is the part that only exists because a process boundary
 * does:
 *
 * - **One handler, one envelope.** A request names a port operation and carries
 *   its arguments; the answer is a result envelope. A refusal crosses as a
 *   value, so the sentence the shell wrote is the sentence the renderer gets,
 *   with no "Error invoking remote method" wrapped around it.
 * - **Payloads are checked at the boundary.** Anything the renderer sends is
 *   unknown until this module has looked at it: an argument that is not the
 *   string an operation needs is refused rather than passed on.
 * - **A document going away abandons its work.** Navigation, close and quit all
 *   take one path: the shell drops the turns in flight and stays usable, so the
 *   document that comes back prompts immediately and nothing streams into a
 *   fresh window from a turn nobody there asked for.
 */
export interface AgentChannel {
  /**
   * Stop serving: abandon live work, unsubscribe from the shell and unregister
   * the handler. Idempotent, and already wired to the window's own close — a
   * caller needs it only for app quit and for tests.
   */
  dispose(): void
}

export function serveAgentChannel(shell: Shell, window: BrowserWindow): AgentChannel {
  const { webContents } = window
  let serving = true

  const unsubscribe = shell.onEvent((event: PortEvent) => {
    if (!serving || webContents.isDestroyed()) return
    webContents.send(EVENT_CHANNEL, event)
  })

  ipcMain.handle(REQUEST_CHANNEL, async (_invocation, request: unknown): Promise<PortResult> => {
    try {
      return { ok: true, value: await invoke(shell, request) }
    } catch (cause) {
      return {
        ok: false,
        message: displaySafeMessage(cause, 'Crucible could not carry that out.')
      }
    }
  })

  /**
   * A new document in the window ends whatever the old one was watching: live
   * turns are dropped and the shell stays ready. Same-document navigations
   * change nothing.
   */
  webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    shell.dispose()
  })

  function dispose(): void {
    if (!serving) return
    serving = false
    shell.dispose()
    unsubscribe()
    ipcMain.removeHandler(REQUEST_CHANNEL)
  }

  window.on('closed', dispose)

  return { dispose }
}

/** The whole of what a renderer may ask for, and the shape each ask must have. */
async function invoke(shell: Shell, request: unknown): Promise<unknown> {
  if (typeof request !== 'object' || request === null) throw new Error('A request has to be an object.')
  const { op, args } = request as { op?: unknown; args?: unknown }
  if (typeof op !== 'string') throw new Error('A request has to name an operation.')
  const given: readonly unknown[] = Array.isArray(args) ? args : []

  /** An argument that has to be a string, or a refusal naming the operation. */
  function text(position: number): string {
    const value = given[position]
    if (typeof value !== 'string') throw new Error(`${op} needs text where it was given none.`)
    return value
  }

  switch (op) {
    case 'snapshot':
      return shell.snapshot()
    case 'addWorkspace':
      return shell.addWorkspace()
    case 'activateWorkspace':
      return shell.activateWorkspace(text(0))
    case 'removeWorkspace':
      return shell.removeWorkspace(text(0))
    case 'createSession':
      return shell.createSession(text(0))
    case 'activateSession':
      return shell.activateSession(text(0))
    case 'removeSession':
      return shell.removeSession(text(0))
    case 'resetSession':
      return shell.resetSession(text(0))
    case 'transcript':
      return shell.transcript(text(0))
    case 'searchHistory':
      return shell.searchHistory(text(0), text(1))
    case 'resumeSession':
      return shell.resumeSession(text(0), text(1))
    case 'listModels':
      return shell.listModels()
    case 'setModel':
      return shell.setModel(text(0), text(1))
    case 'setThinkingLevel':
      return shell.setThinkingLevel(text(0), text(1))
    case 'prompt':
      return shell.prompt(text(0), text(1))
    case 'cancel':
      return shell.cancel(text(0))
    default:
      throw new Error('Crucible was asked for something it does not do.')
  }
}
