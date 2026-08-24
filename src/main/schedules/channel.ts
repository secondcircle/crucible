import { ipcMain, type BrowserWindow } from 'electron'
import {
  SCHEDULE_EVENT_CHANNEL,
  SCHEDULE_REQUEST_CHANNEL,
  type ScheduleResult
} from '../../shared/schedules/channels'
import type { MainScheduleService, ScheduleService } from '../../shared/schedules/service'
import { displaySafeMessage } from '../agent/adapter-error'

// Plumbing only, exactly as the other channels are: every rule about when a
// schedule fires lives behind the service.

export interface ScheduleChannel {
  dispose(): void
}

export function serveScheduleChannel(
  service: MainScheduleService,
  window: BrowserWindow
): ScheduleChannel {
  let serving = true

  ipcMain.handle(
    SCHEDULE_REQUEST_CHANNEL,
    async (_invocation, request: unknown): Promise<ScheduleResult> => {
      try {
        return { ok: true, value: await invoke(service, request) }
      } catch (cause) {
        return { ok: false, message: displaySafeMessage(cause, 'That schedule operation failed.') }
      }
    }
  )

  const stopEvents = service.onEvent((event) => {
    if (window.isDestroyed()) return
    window.webContents.send(SCHEDULE_EVENT_CHANNEL, event)
  })

  function dispose(): void {
    if (!serving) return
    serving = false
    stopEvents()
    ipcMain.removeHandler(SCHEDULE_REQUEST_CHANNEL)
  }

  window.on('closed', dispose)

  return { dispose }
}

// Everything from the renderer is unknown until it has been checked here.
export async function invoke(service: ScheduleService, request: unknown): Promise<unknown> {
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

  function flag(position: number): boolean {
    const value = given[position]
    if (typeof value !== 'boolean') throw new Error(`${op} needs a yes or no where it was given none.`)
    return value
  }

  switch (op) {
    case 'snapshot':
      return service.snapshot()
    case 'setEnabled':
      return service.setEnabled(text(0), text(1), flag(2))
    case 'setAllPaused':
      return service.setAllPaused(text(0), flag(1))
    case 'runNow':
      return service.runNow(text(0), text(1))
    default:
      throw new Error('Crucible was asked for something its schedule service does not do.')
  }
}
