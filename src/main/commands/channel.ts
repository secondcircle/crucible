import { ipcMain, type BrowserWindow } from 'electron'
import { COMMAND_REQUEST_CHANNEL, type CommandResult } from '../../shared/commands/channels'
import type { CommandService } from '../../shared/commands/service'
import { displaySafeMessage } from '../agent/adapter-error'

// Plumbing only, exactly as the agent and workspace channels are: every rule
// about what a command is lives in the service.
export interface CommandChannel {
  dispose(): void
}

export function serveCommandChannel(
  service: CommandService,
  window: BrowserWindow
): CommandChannel {
  let serving = true

  ipcMain.handle(
    COMMAND_REQUEST_CHANNEL,
    async (_invocation, request: unknown): Promise<CommandResult> => {
      try {
        return { ok: true, value: await invoke(service, request) }
      } catch (cause) {
        return {
          ok: false,
          message: displaySafeMessage(cause, 'That command could not be read.')
        }
      }
    }
  )

  function dispose(): void {
    if (!serving) return
    serving = false
    ipcMain.removeHandler(COMMAND_REQUEST_CHANNEL)
  }

  window.on('closed', dispose)

  return { dispose }
}

// Everything from the renderer is unknown until it has been checked here.
export async function invoke(service: CommandService, request: unknown): Promise<unknown> {
  if (typeof request !== 'object' || request === null) {
    throw new Error('A request has to be an object.')
  }
  const { op, args } = request as { op?: unknown; args?: unknown }
  if (typeof op !== 'string') throw new Error('A request has to name an operation.')
  const given: readonly unknown[] = Array.isArray(args) ? args : []

  function text(position: number): string {
    const value = given[position]
    if (typeof value !== 'string') throw new Error(`${op} needs text where it was given none.`)
    return value
  }

  switch (op) {
    case 'list':
      return service.list(text(0))
    case 'expand':
      return service.expand(text(0), text(1))
    default:
      throw new Error('Crucible was asked for something its command service does not do.')
  }
}
