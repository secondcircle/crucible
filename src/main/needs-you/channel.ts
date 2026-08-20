import { ipcMain, type BrowserWindow } from 'electron'
import {
  NEEDS_YOU_REQUEST_CHANNEL,
  type NeedsYouResult
} from '../../shared/needs-you/channels'
import type { NeedsYouService, WaitingSession } from '../../shared/needs-you/service'
import { displaySafeMessage } from '../agent/adapter-error'

// Plumbing only, exactly as the update channel is: what a badge or a banner
// means lives in the service. Questions go one way — main announces nothing
// back, because the click on a banner is served by activating the session
// rather than by telling the renderer about it.
export interface NeedsYouChannel {
  dispose(): void
}

export function serveNeedsYouChannel(
  service: NeedsYouService,
  window: BrowserWindow
): NeedsYouChannel {
  let serving = true

  ipcMain.handle(
    NEEDS_YOU_REQUEST_CHANNEL,
    async (_invocation, request: unknown): Promise<NeedsYouResult> => {
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
    ipcMain.removeHandler(NEEDS_YOU_REQUEST_CHANNEL)
  }

  window.on('closed', dispose)

  return { dispose }
}

// Everything from the renderer is unknown until it has been checked here.
export async function invoke(service: NeedsYouService, request: unknown): Promise<unknown> {
  if (typeof request !== 'object' || request === null) {
    throw new Error('A request has to be an object.')
  }
  const { op, args } = request as { op?: unknown; args?: unknown }
  if (typeof op !== 'string') throw new Error('A request has to name an operation.')
  const given = Array.isArray(args) ? args : []

  switch (op) {
    case 'waiting':
      return service.waiting(typeof given[0] === 'number' ? given[0] : 0)
    case 'announce':
      return service.announce(waitingSession(given[0]))
    default:
      throw new Error('Crucible was asked for something its needs-you service does not do.')
  }
}

// A banner names a session, a workspace and a title, and anything short of all
// three is not a banner worth showing.
function waitingSession(given: unknown): WaitingSession {
  if (typeof given !== 'object' || given === null) {
    throw new Error('A finished session has to be an object.')
  }
  const { sessionId, workspace, title } = given as {
    sessionId?: unknown
    workspace?: unknown
    title?: unknown
  }
  if (typeof sessionId !== 'string' || typeof workspace !== 'string' || typeof title !== 'string') {
    throw new Error('A finished session has to name its session, its workspace and its title.')
  }
  return { sessionId, workspace, title }
}
