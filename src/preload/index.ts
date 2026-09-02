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
import type { AppVersionState } from '../shared/app-update/service'
import {
  CACHE_EVENT_CHANNEL,
  CACHE_REQUEST_CHANNEL,
  type CacheRequest,
  type CacheResult
} from '../shared/cache/channels'
import type { CacheHealth } from '../shared/cache/service'
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
  SCHEDULE_EVENT_CHANNEL,
  SCHEDULE_REQUEST_CHANNEL,
  type ScheduleEvent,
  type ScheduleRequest,
  type ScheduleResult
} from '../shared/schedules/channels'
import {
  WORKSPACE_EVENT_CHANNEL,
  WORKSPACE_REQUEST_CHANNEL,
  type WorkspaceRequest,
  type WorkspaceResult
} from '../shared/workspace/channels'
import { INSTANCE_ARGUMENT } from '../shared/instance'
import type { WorkspaceEvent } from '../shared/workspace/service'
import {
  WORKFLOW_RUN_EVENT_CHANNEL,
  WORKFLOW_RUN_REQUEST_CHANNEL,
  type WorkflowRunEvent,
  type WorkflowRunRequest,
  type WorkflowRunResult
} from '../shared/workflows/channels'

// Which state directory this window runs against, as main worked it out and
// passed it at creation. A static value: it needs no channel and no event, and
// its absence is how the installed app shows no badge.
const instance = process.argv
  .find((argument) => argument.startsWith(INSTANCE_ARGUMENT))
  ?.slice(INSTANCE_ARGUMENT.length)

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
  // A mark, not a capability: the renderer shows it and asks nothing of it.
  instance,

  // Which OS this window is on, exposed once. The renderer's key module owns
  // every reading of it — which chord is this platform's, and how a key is
  // spelled on screen — so behavior and label cannot drift apart.
  platform: process.platform,

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

  // The cache ledger's counter: the strip asks, main's single ledger answers,
  // and a miss landing in any session or any run moves every strip on screen.
  cache: {
    request: (request: CacheRequest): Promise<CacheResult> =>
      ipcRenderer.invoke(CACHE_REQUEST_CHANNEL, request),

    onEvent: (listener: (health: CacheHealth) => void): (() => void) =>
      forwarder(CACHE_EVENT_CHANNEL, listener)
  },

  // The sidebar mark's two channels outside the window. One way only: main
  // serves a clicked banner by activating the session, which the renderer
  // hears about as an ordinary state event.
  needsYou: {
    request: (request: NeedsYouRequest): Promise<NeedsYouResult> =>
      ipcRenderer.invoke(NEEDS_YOU_REQUEST_CHANNEL, request)
  },

  // Workflow runs: the strip, the run view and the global ⌘R view all read
  // this one seam; run tools never cross it — they live with the agent.
  workflowRuns: {
    request: (request: WorkflowRunRequest): Promise<WorkflowRunResult> =>
      ipcRenderer.invoke(WORKFLOW_RUN_REQUEST_CHANNEL, request),

    onEvent: (listener: (event: WorkflowRunEvent) => void): (() => void) =>
      forwarder(WORKFLOW_RUN_EVENT_CHANNEL, listener)
  },

  // Schedules: what a repo declares, when each fires next, and the three
  // commands the board issues. Runs never cross here — they have their own
  // seam, and nothing about a run is restated on this one.
  schedules: {
    request: (request: ScheduleRequest): Promise<ScheduleResult> =>
      ipcRenderer.invoke(SCHEDULE_REQUEST_CHANNEL, request),

    onEvent: (listener: (event: ScheduleEvent) => void): (() => void) =>
      forwarder(SCHEDULE_EVENT_CHANNEL, listener)
  },

  // The version seam: one question, one event, one restart.
  appUpdate: {
    request: (request: AppUpdateRequest): Promise<AppUpdateResult> =>
      ipcRenderer.invoke(APP_UPDATE_REQUEST_CHANNEL, request),

    onEvent: (listener: (state: AppVersionState) => void): (() => void) =>
      forwarder(APP_UPDATE_EVENT_CHANNEL, listener)
  }
})

// The one signal that the bundled preload loaded at all, which is otherwise
// invisible in a running app.
console.info('[crucible] preload loaded')
