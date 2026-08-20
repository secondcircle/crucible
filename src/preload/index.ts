import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  EVENT_CHANNEL,
  REQUEST_CHANNEL,
  type PortRequest,
  type PortResult
} from '../shared/agent/channels'
import type { PortEvent } from '../shared/agent/port'
import {
  COMMAND_REQUEST_CHANNEL,
  type CommandRequest,
  type CommandResult
} from '../shared/commands/channels'
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

  // Beside the agent as well: a command is expanded before anything crosses
  // the port, and the port never learns commands exist (ADR 0007). Questions
  // only — the service announces nothing.
  commands: {
    request: (request: CommandRequest): Promise<CommandResult> =>
      ipcRenderer.invoke(COMMAND_REQUEST_CHANNEL, request)
  }
})

// The one signal that the bundled preload loaded at all, which is otherwise
// invisible in a running app.
console.info('[crucible] preload loaded')
