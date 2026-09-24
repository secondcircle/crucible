import { ipcMain, type BrowserWindow } from 'electron'
import { BOARD_WINDOWS, type BoardScope, type BoardWindow } from '../../shared/rules/board'
import { RULES_EVENT_CHANNEL, RULES_REQUEST_CHANNEL, type RulesResult } from '../../shared/rules/channels'
import type { RulesService } from '../../shared/rules/service'
import { displaySafeMessage } from '../agent/adapter-error'

// Plumbing only, exactly as the other channels are: everything about what a
// rule did lives behind the service.

export interface RulesChannel {
  dispose(): void
}

export function serveRulesChannel(service: RulesService, window: BrowserWindow): RulesChannel {
  let serving = true

  ipcMain.handle(RULES_REQUEST_CHANNEL, async (_invocation, request: unknown): Promise<RulesResult> => {
    try {
      return { ok: true, value: await invoke(service, request) }
    } catch (cause) {
      return { ok: false, message: displaySafeMessage(cause, 'The rules could not be read.') }
    }
  })

  const stopEvents = service.onEvent((event) => {
    if (window.isDestroyed()) return
    window.webContents.send(RULES_EVENT_CHANNEL, event)
  })

  function dispose(): void {
    if (!serving) return
    serving = false
    stopEvents()
    ipcMain.removeHandler(RULES_REQUEST_CHANNEL)
  }

  window.on('closed', dispose)

  return { dispose }
}

// Everything from the renderer is unknown until it has been checked here.
export async function invoke(service: RulesService, request: unknown): Promise<unknown> {
  if (typeof request !== 'object' || request === null) throw new Error('A request has to be an object.')
  const { op, args } = request as { op?: unknown; args?: unknown }
  if (typeof op !== 'string') throw new Error('A request has to name an operation.')
  const given: readonly unknown[] = Array.isArray(args) ? args : []

  function text(position: number): string {
    const value = given[position]
    if (typeof value !== 'string') throw new Error(`${op} needs text where it was given none.`)
    return value
  }

  function scope(position: number): BoardScope {
    const value = given[position] as { kind?: unknown; sessionId?: unknown; runId?: unknown } | undefined
    if (value?.kind === 'workspace') return { kind: 'workspace' }
    if (value?.kind === 'session' && typeof value.sessionId === 'string') return { kind: 'session', sessionId: value.sessionId }
    if (value?.kind === 'run' && typeof value.runId === 'string') return { kind: 'run', runId: value.runId }
    throw new Error(`${op} needs a scope: the workspace, a session or a run.`)
  }

  function window(position: number): BoardWindow {
    const value = given[position]
    if (!BOARD_WINDOWS.includes(value as BoardWindow)) throw new Error(`${op} needs a window: today, 7d, 30d or all.`)
    return value as BoardWindow
  }

  switch (op) {
    case 'health':
      return service.health(text(0))
    case 'board':
      return service.board(text(0), scope(1), window(2))
    case 'firings':
      return service.firings(text(0), scope(1))
    default:
      throw new Error('Crucible was asked for something its rules service does not do.')
  }
}
