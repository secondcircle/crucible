import { ipcMain, type BrowserWindow } from 'electron'
import {
  WORKFLOW_RUN_EVENT_CHANNEL,
  WORKFLOW_RUN_REQUEST_CHANNEL,
  type WorkflowRunResult
} from '../../shared/workflows/channels'
import type { MainWorkflowRunService, WorkflowRunService } from '../../shared/workflows/service'
import { displaySafeMessage } from '../agent/adapter-error'

// Plumbing only, exactly as the other channels are: every rule about what a
// run is lives behind the service.

export interface WorkflowRunChannel {
  dispose(): void
}

export function serveWorkflowRunChannel(
  service: MainWorkflowRunService,
  window: BrowserWindow
): WorkflowRunChannel {
  let serving = true

  ipcMain.handle(
    WORKFLOW_RUN_REQUEST_CHANNEL,
    async (_invocation, request: unknown): Promise<WorkflowRunResult> => {
      try {
        return { ok: true, value: await invoke(service, request) }
      } catch (cause) {
        return { ok: false, message: displaySafeMessage(cause, 'That run operation failed.') }
      }
    }
  )

  const stopEvents = service.onEvent((event) => {
    if (window.isDestroyed()) return
    window.webContents.send(WORKFLOW_RUN_EVENT_CHANNEL, event)
  })

  function dispose(): void {
    if (!serving) return
    serving = false
    stopEvents()
    ipcMain.removeHandler(WORKFLOW_RUN_REQUEST_CHANNEL)
  }

  window.on('closed', dispose)

  return { dispose }
}

// Everything from the renderer is unknown until it has been checked here.
export async function invoke(service: WorkflowRunService, request: unknown): Promise<unknown> {
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
    case 'pause':
      return service.pause(text(0))
    case 'resume':
      return service.resume(text(0))
    case 'cancel':
      return service.cancel(text(0))
    case 'nodeTranscript':
      return service.nodeTranscript(text(0), text(1))
    default:
      throw new Error('Crucible was asked for something its run service does not do.')
  }
}
