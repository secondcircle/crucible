import { ipcMain, type BrowserWindow } from 'electron'
import {
  QUOTA_EVENT_CHANNEL,
  QUOTA_REQUEST_CHANNEL,
  type QuotaResult
} from '../../shared/quota/channels'
import type { QuotaService } from '../../shared/quota/service'
import type { QuotaSnapshot } from '../../shared/quota/types'
import { displaySafeMessage } from '../agent/adapter-error'

// Plumbing only, exactly as the workspace and update channels are: what a
// refresh means lives in the service. Main hosts one service and every window
// is served over it, so the result of a refresh any window triggered reaches
// each of them and the TTL makes the duplicate triggers free.
export interface QuotaChannel {
  dispose(): void
}

export function serveQuotaChannel(service: QuotaService, window: BrowserWindow): QuotaChannel {
  const { webContents } = window
  let serving = true

  const unsubscribe = service.onChange((snapshot: QuotaSnapshot) => {
    if (!serving || webContents.isDestroyed()) return
    webContents.send(QUOTA_EVENT_CHANNEL, snapshot)
  })

  ipcMain.handle(
    QUOTA_REQUEST_CHANNEL,
    async (_invocation, request: unknown): Promise<QuotaResult> => {
      try {
        return { ok: true, value: await invoke(service, request) }
      } catch (cause) {
        return {
          ok: false,
          message: displaySafeMessage(cause, 'Crucible could not read the quota.')
        }
      }
    }
  )

  function dispose(): void {
    if (!serving) return
    serving = false
    unsubscribe()
    ipcMain.removeHandler(QUOTA_REQUEST_CHANNEL)
  }

  window.on('closed', dispose)

  return { dispose }
}

// Everything from the renderer is unknown until it has been checked here.
export async function invoke(service: QuotaService, request: unknown): Promise<unknown> {
  if (typeof request !== 'object' || request === null) {
    throw new Error('A request has to be an object.')
  }
  const { op, args } = request as { op?: unknown; args?: unknown }
  if (typeof op !== 'string') throw new Error('A request has to name an operation.')
  const given = Array.isArray(args) ? args : []

  switch (op) {
    case 'read':
      return service.read()
    case 'refresh':
      return service.refresh(refreshOptions(given[0]))
    default:
      throw new Error('Crucible was asked for something its quota service does not do.')
  }
}

/** A scope is a list of provider ids or nothing at all; anything else is nothing. */
function refreshOptions(given: unknown): { providers?: readonly string[] } {
  if (typeof given !== 'object' || given === null) return {}
  const { providers } = given as { providers?: unknown }
  if (!Array.isArray(providers)) return {}
  return { providers: providers.filter((id): id is string => typeof id === 'string') }
}
