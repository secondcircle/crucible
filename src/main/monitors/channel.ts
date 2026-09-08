import { ipcMain, type BrowserWindow } from 'electron'
import {
  MONITOR_EVENT_CHANNEL,
  MONITOR_REQUEST_CHANNEL,
  type MonitorResult
} from '../../shared/monitors/channels'
import type { MainMonitorService, MonitorService } from '../../shared/monitors/service'
import { displaySafeMessage } from '../agent/adapter-error'

// Plumbing only, exactly as the other channels are: every rule about what a
// monitor is lives behind the service.

export interface MonitorChannel {
  dispose(): void
}

export function serveMonitorChannel(
  service: MainMonitorService,
  window: BrowserWindow
): MonitorChannel {
  let serving = true

  ipcMain.handle(
    MONITOR_REQUEST_CHANNEL,
    async (_invocation, request: unknown): Promise<MonitorResult> => {
      try {
        return { ok: true, value: await invoke(service, request) }
      } catch (cause) {
        return { ok: false, message: displaySafeMessage(cause, 'That monitor operation failed.') }
      }
    }
  )

  const stopEvents = service.onEvent((event) => {
    if (window.isDestroyed()) return
    window.webContents.send(MONITOR_EVENT_CHANNEL, event)
  })

  function dispose(): void {
    if (!serving) return
    serving = false
    stopEvents()
    ipcMain.removeHandler(MONITOR_REQUEST_CHANNEL)
  }

  window.on('closed', dispose)

  return { dispose }
}

/** Everything from the renderer is unknown until it has been checked here. */
export async function invoke(service: MonitorService, request: unknown): Promise<unknown> {
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
    case 'snapshot':
      return service.snapshot()
    case 'stop':
      return service.stop(text(0))
    default:
      throw new Error('Crucible was asked for something its monitor service does not do.')
  }
}
