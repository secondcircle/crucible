import { ipcMain, type BrowserWindow } from 'electron'
import {
  CACHE_EVENT_CHANNEL,
  CACHE_REQUEST_CHANNEL,
  type CacheResult
} from '../../shared/cache/channels'
import type { CacheHealth, CacheService } from '../../shared/cache/service'
import { displaySafeMessage } from '../agent/adapter-error'

// Plumbing only: what a reset means lives in the ledger. Every window is
// served over the one service, so a miss landing in any session or any run
// moves every strip on screen.
export interface CacheChannel {
  dispose(): void
}

export function serveCacheChannel(service: CacheService, window: BrowserWindow): CacheChannel {
  const { webContents } = window
  let serving = true

  const unsubscribe = service.onChange((health: CacheHealth) => {
    if (!serving || webContents.isDestroyed()) return
    webContents.send(CACHE_EVENT_CHANNEL, health)
  })

  ipcMain.handle(
    CACHE_REQUEST_CHANNEL,
    async (_invocation, request: unknown): Promise<CacheResult> => {
      try {
        return { ok: true, value: await invoke(service, request) }
      } catch (cause) {
        return {
          ok: false,
          message: displaySafeMessage(cause, 'Crucible could not read the cache ledger.')
        }
      }
    }
  )

  function dispose(): void {
    if (!serving) return
    serving = false
    unsubscribe()
    ipcMain.removeHandler(CACHE_REQUEST_CHANNEL)
  }

  window.on('closed', dispose)

  return { dispose }
}

// Everything from the renderer is unknown until it has been checked here.
export async function invoke(service: CacheService, request: unknown): Promise<unknown> {
  if (typeof request !== 'object' || request === null) {
    throw new Error('A request has to be an object.')
  }
  const { op } = request as { op?: unknown }
  if (typeof op !== 'string') throw new Error('A request has to name an operation.')

  switch (op) {
    case 'read':
      return service.read()
    case 'reset':
      return service.reset()
    default:
      throw new Error('Crucible was asked for something its cache service does not do.')
  }
}
