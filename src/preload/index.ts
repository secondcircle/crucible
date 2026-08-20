import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  EVENT_CHANNEL,
  REQUEST_CHANNEL,
  type PortRequest,
  type PortResult
} from '../shared/agent/channels'
import type { PortEvent } from '../shared/agent/port'
import {
  APP_UPDATE_EVENT_CHANNEL,
  APP_UPDATE_REQUEST_CHANNEL,
  type AppUpdateRequest,
  type AppUpdateResult
} from '../shared/app-update/channels'
import type { UpdateReady } from '../shared/app-update/service'
import {
  COMMAND_REQUEST_CHANNEL,
  type CommandRequest,
  type CommandResult
} from '../shared/commands/channels'
import {
  NEEDS_YOU_REQUEST_CHANNEL,
  type NeedsYouRequest,
  type NeedsYouResult
} from '../shared/needs-you/channels'
import {
  QUOTA_EVENT_CHANNEL,
  QUOTA_REQUEST_CHANNEL,
  type QuotaRequest,
  type QuotaResult
} from '../shared/quota/channels'
import type { QuotaSnapshot } from '../shared/quota/types'
import {
  WORKSPACE_EVENT_CHANNEL,
  WORKSPACE_REQUEST_CHANNEL,
  type WorkspaceRequest,
  type WorkspaceResult
} from '../shared/workspace/channels'
import type { WorkspaceEvent } from '../shared/workspace/service'

// Never `ipcRenderer.on(channel, listener)`: that hands the caller the Electron
// event as its first argument.
function forwarder<T>(channel: string, listener: (event: T) => void): () => void {
  const forward = (_electronEvent: IpcRendererEvent, event: T): void => {
    listener(event)
  }
  ipcRenderer.on(channel, forward)
  return () => {
    ipcRenderer.off(channel, forward)
  }
}

// The whole of what the sandboxed renderer may reach of Electron: no general
// passthrough, and nothing carrying a `sender` crosses.
contextBridge.exposeInMainWorld('crucible', {
  agent: {
    request: (request: PortRequest): Promise<PortResult> =>
      ipcRenderer.invoke(REQUEST_CHANNEL, request),

    onEvent: (listener: (event: PortEvent) => void): (() => void) =>
      forwarder(EVENT_CHANNEL, listener)
  },

  // Beside the agent, never behind it: file search and bash runs are OS facts
  // about the workspace folder.
  workspace: {
    request: (request: WorkspaceRequest): Promise<WorkspaceResult> =>
      ipcRenderer.invoke(WORKSPACE_REQUEST_CHANNEL, request),

    onEvent: (listener: (event: WorkspaceEvent) => void): (() => void) =>
      forwarder(WORKSPACE_EVENT_CHANNEL, listener)
  },

  // Expanded before anything crosses the port, so the port never learns
  // commands exist. Questions only: the service announces nothing.
  commands: {
    request: (request: CommandRequest): Promise<CommandResult> =>
      ipcRenderer.invoke(COMMAND_REQUEST_CHANNEL, request)
  },

  // Global provider quota: the strip asks, main's single store answers, and
  // every window hears the result of every refresh.
  quota: {
    request: (request: QuotaRequest): Promise<QuotaResult> =>
      ipcRenderer.invoke(QUOTA_REQUEST_CHANNEL, request),

    onEvent: (listener: (snapshot: QuotaSnapshot) => void): (() => void) =>
      forwarder(QUOTA_EVENT_CHANNEL, listener)
  },

  // The sidebar mark's two channels outside the window. One way only: main
  // serves a clicked banner by activating the session, which the renderer
  // hears about as an ordinary state event.
  needsYou: {
    request: (request: NeedsYouRequest): Promise<NeedsYouResult> =>
      ipcRenderer.invoke(NEEDS_YOU_REQUEST_CHANNEL, request)
  },

  // The installed app's update seam: one question, one event, one restart.
  appUpdate: {
    request: (request: AppUpdateRequest): Promise<AppUpdateResult> =>
      ipcRenderer.invoke(APP_UPDATE_REQUEST_CHANNEL, request),

    onEvent: (listener: (event: UpdateReady) => void): (() => void) =>
      forwarder(APP_UPDATE_EVENT_CHANNEL, listener)
  }
})

// The one signal that the bundled preload loaded at all, which is otherwise
// invisible in a running app.
console.info('[crucible] preload loaded')
