import { ipcMain, type BrowserWindow } from 'electron'
import { EVENT_CHANNEL, REQUEST_CHANNEL, type PortResult } from '../../shared/agent/channels'
import type { PortEvent, QueuedKind } from '../../shared/agent/port'
import type { Shell } from '../shell/shell'
import { displaySafeMessage } from './adapter-error'

// Plumbing only: every rule about turns, guards and ordering lives in the
// shell, which is what lets that behavior be tested without Electron. A
// refusal crosses as a value rather than a throw, so the sentence the shell
// wrote is the sentence the renderer gets.
export interface AgentChannel {
  // Already wired to the window's own close, so a caller needs it only for app
  // quit and for tests.
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

  // A new document ends what the old one was watching, so nothing streams into
  // a fresh window from a turn nobody there asked for.
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

// Everything from the renderer is unknown until it has been checked here.
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

  /** One of π's two queues, named, or a refusal: there is no third kind. */
  function kind(position: number): QueuedKind {
    const value = given[position]
    if (value !== 'steering' && value !== 'followUp') {
      throw new Error(`${op} needs a queue to name, and that is not one.`)
    }
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
    case 'steer':
      return shell.steer(text(0), text(1))
    case 'followUp':
      return shell.followUp(text(0), text(1))
    case 'dequeue':
      return shell.dequeue(text(0), kind(1), text(2))
    case 'cancel':
      return shell.cancel(text(0))
    default:
      throw new Error('Crucible was asked for something it does not do.')
  }
}
