import { ipcMain, type BrowserWindow } from 'electron'
import {
  CATALOG_EVENT_CHANNEL,
  CATALOG_REQUEST_CHANNEL,
  type CatalogResult
} from '../../shared/workflows/catalog-channels'
import type {
  MainWorkflowCatalogService,
  WorkflowCatalogService
} from '../../shared/workflows/catalog'
import { readCatalogReaderSettings } from '../../shared/workflows/catalog-settings'
import { displaySafeMessage } from '../agent/adapter-error'

// Plumbing only, exactly as the other channels are: every rule about what a
// reading is lives behind the service.

export interface CatalogChannel {
  dispose(): void
}

export function serveCatalogChannel(
  service: MainWorkflowCatalogService,
  window: BrowserWindow
): CatalogChannel {
  let serving = true

  ipcMain.handle(
    CATALOG_REQUEST_CHANNEL,
    async (_invocation, request: unknown): Promise<CatalogResult> => {
      try {
        return { ok: true, value: await invoke(service, request) }
      } catch (cause) {
        return { ok: false, message: displaySafeMessage(cause, 'That catalog operation failed.') }
      }
    }
  )

  const stopEvents = service.onEvent((event) => {
    if (window.isDestroyed()) return
    window.webContents.send(CATALOG_EVENT_CHANNEL, event)
  })

  function dispose(): void {
    if (!serving) return
    serving = false
    stopEvents()
    ipcMain.removeHandler(CATALOG_REQUEST_CHANNEL)
  }

  window.on('closed', dispose)

  return { dispose }
}

// Everything from the renderer is unknown until it has been checked here.
export async function invoke(service: WorkflowCatalogService, request: unknown): Promise<unknown> {
  if (typeof request !== 'object' || request === null) {
    throw new Error('A request has to be an object.')
  }
  const { op, args } = request as { op?: unknown; args?: unknown }
  if (typeof op !== 'string') throw new Error('A request has to name an operation.')
  const given: readonly unknown[] = Array.isArray(args) ? args : []

  switch (op) {
    case 'snapshot':
      return service.snapshot()
    case 'open': {
      const path = given[0]
      if (typeof path !== 'string' || path === '') throw new Error('open needs a workspace folder.')
      return service.open(path)
    }
    case 'setReader': {
      const asked = given[0]
      if (typeof asked !== 'object' || asked === null) throw new Error('setReader needs a model and an effort.')
      return service.setReader(readCatalogReaderSettings(asked))
    }
    default:
      throw new Error('Crucible was asked for something its workflow catalog does not do.')
  }
}
