import { ipcMain, type BrowserWindow } from 'electron'
import {
  WORKSPACE_EVENT_CHANNEL,
  WORKSPACE_REQUEST_CHANNEL,
  type WorkspaceResult
} from '../../shared/workspace/channels'
import type { WorkspaceEvent, WorkspaceService } from '../../shared/workspace/service'
import { displaySafeMessage } from '../agent/adapter-error'

// Plumbing only, exactly as the agent channel is: every rule about what a
// search or a run means lives in the service.
export interface WorkspaceChannel {
  dispose(): void
}

export function serveWorkspaceChannel(
  service: WorkspaceService,
  window: BrowserWindow
): WorkspaceChannel {
  const { webContents } = window
  let serving = true

  const unsubscribe = service.onEvent((event: WorkspaceEvent) => {
    if (!serving || webContents.isDestroyed()) return
    webContents.send(WORKSPACE_EVENT_CHANNEL, event)
  })

  ipcMain.handle(
    WORKSPACE_REQUEST_CHANNEL,
    async (_invocation, request: unknown): Promise<WorkspaceResult> => {
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
    ipcMain.removeHandler(WORKSPACE_REQUEST_CHANNEL)
  }

  window.on('closed', dispose)

  return { dispose }
}

// Everything from the renderer is unknown until it has been checked here.
export async function invoke(service: WorkspaceService, request: unknown): Promise<unknown> {
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
    case 'searchFiles':
      return service.searchFiles(text(0), text(1))
    case 'startRun':
      return service.startRun(text(0), text(1))
    case 'stopRun':
      return service.stopRun(text(0))
    default:
      throw new Error('Crucible was asked for something its workspace service does not do.')
  }
}
