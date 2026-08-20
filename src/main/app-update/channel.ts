import { ipcMain, type BrowserWindow } from 'electron'
import {
  APP_UPDATE_EVENT_CHANNEL,
  APP_UPDATE_REQUEST_CHANNEL,
  type AppUpdateResult
} from '../../shared/app-update/channels'
import type { AppUpdateService, UpdateReady } from '../../shared/app-update/service'
import { displaySafeMessage } from '../agent/adapter-error'

// Plumbing only, exactly as the workspace channel is: what an update means
// lives in the service.
export interface AppUpdateChannel {
  dispose(): void
}

export function serveAppUpdateChannel(
  service: AppUpdateService,
  window: BrowserWindow
): AppUpdateChannel {
  const { webContents } = window
  let serving = true

  const unsubscribe = service.onEvent((event: UpdateReady) => {
    if (!serving || webContents.isDestroyed()) return
    webContents.send(APP_UPDATE_EVENT_CHANNEL, event)
  })

  ipcMain.handle(
    APP_UPDATE_REQUEST_CHANNEL,
    async (_invocation, request: unknown): Promise<AppUpdateResult> => {
      try {
        return { ok: true, value: await invoke(service, request) }
      } catch (cause) {
        return {
          ok: false,
          message: displaySafeMessage(cause, 'Crucible could not carry that out.')
        }
      }
    }
  )

  function dispose(): void {
    if (!serving) return
    serving = false
    unsubscribe()
    ipcMain.removeHandler(APP_UPDATE_REQUEST_CHANNEL)
  }

  window.on('closed', dispose)

  return { dispose }
}

// Everything from the renderer is unknown until it has been checked here.
export async function invoke(service: AppUpdateService, request: unknown): Promise<unknown> {
  if (typeof request !== 'object' || request === null) {
    throw new Error('A request has to be an object.')
  }
  const { op } = request as { op?: unknown }
  if (typeof op !== 'string') throw new Error('A request has to name an operation.')

  switch (op) {
    case 'pending':
      return service.pending()
    case 'restart':
      return service.restart()
    default:
      throw new Error('Crucible was asked for something its update service does not do.')
  }
}
