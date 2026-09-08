import type { AppUpdateRequest, AppUpdateResult } from '../../shared/app-update/channels'
import type { AppVersionState } from '../../shared/app-update/service'
import type { PortRequest, PortResult } from '../../shared/agent/channels'
import type { PortEvent } from '../../shared/agent/port'
import type { CacheRequest, CacheResult } from '../../shared/cache/channels'
import type { CacheHealth } from '../../shared/cache/service'
import type { CommandRequest, CommandResult } from '../../shared/commands/channels'
import type { NeedsYouRequest, NeedsYouResult } from '../../shared/needs-you/channels'
import type { QuotaRequest, QuotaResult } from '../../shared/quota/channels'
import type { QuotaSnapshot } from '../../shared/quota/types'
import type {
  ScheduleEvent,
  ScheduleRequest,
  ScheduleResult
} from '../../shared/schedules/channels'
import type { WorkspaceRequest, WorkspaceResult } from '../../shared/workspace/channels'
import type { WorkspaceEvent } from '../../shared/workspace/service'
import type {
  WorkflowRunEvent,
  WorkflowRunRequest,
  WorkflowRunResult
} from '../../shared/workflows/channels'
import type {
  MonitorEvent,
  MonitorRequestMessage,
  MonitorResult
} from '../../shared/monitors/channels'

// The one module in the renderer that may name `window.crucible`, so a missing
// preload is caught in one place instead of surfacing as an absent method.

/** The agent half of the preload surface: one object, two members. */
export interface CrucibleAgent {
  request(request: PortRequest): Promise<PortResult>
  onEvent(listener: (event: PortEvent) => void): () => void
}

/** The workspace half, shaped identically because it is the same pattern. */
export interface CrucibleWorkspace {
  request(request: WorkspaceRequest): Promise<WorkspaceResult>
  onEvent(listener: (event: WorkspaceEvent) => void): () => void
}

/** The command half. One member: the service answers questions and announces nothing. */
export interface CrucibleCommands {
  request(request: CommandRequest): Promise<CommandResult>
}

/** The version half, same pattern: main announces a snapshot, we ask to restart. */
export interface CrucibleAppUpdate {
  request(request: AppUpdateRequest): Promise<AppUpdateResult>
  onEvent(listener: (state: AppVersionState) => void): () => void
}

export interface CrucibleQuota {
  request(request: QuotaRequest): Promise<QuotaResult>
  onEvent(listener: (snapshot: QuotaSnapshot) => void): () => void
}

export interface CrucibleCache {
  request(request: CacheRequest): Promise<CacheResult>
  onEvent(listener: (health: CacheHealth) => void): () => void
}

/** The needs-you half. One member: main announces nothing back. */
export interface CrucibleNeedsYou {
  request(request: NeedsYouRequest): Promise<NeedsYouResult>
}

/** The workflow-run half, shaped like the others. */
export interface CrucibleWorkflowRuns {
  request(request: WorkflowRunRequest): Promise<WorkflowRunResult>
  onEvent(listener: (event: WorkflowRunEvent) => void): () => void
}

/** The schedule half, shaped like the run half because it is the same pattern. */
export interface CrucibleSchedules {
  request(request: ScheduleRequest): Promise<ScheduleResult>
  onEvent(listener: (event: ScheduleEvent) => void): () => void
}

/** The monitor half, shaped like the run half for the same reason. */
export interface CrucibleMonitors {
  request(request: MonitorRequestMessage): Promise<MonitorResult>
  onEvent(listener: (event: MonitorEvent) => void): () => void
}

declare global {
  interface Window {
    crucible?: {
      // The state directory this window runs against, as a badge: `dev`, or
      // `dev · <suffix>` in a worktree launch. Absent in the installed app.
      instance?: string
      // The OS this window is on, as main's own process reports it. Read by
      // the key module and by nothing else.
      platform?: string
      agent?: CrucibleAgent
      workspace?: CrucibleWorkspace
      commands?: CrucibleCommands
      appUpdate?: CrucibleAppUpdate
      quota?: CrucibleQuota
      cache?: CrucibleCache
      needsYou?: CrucibleNeedsYou
      workflowRuns?: CrucibleWorkflowRuns
      schedules?: CrucibleSchedules
      monitors?: CrucibleMonitors
    }
  }
}

// A missing surface means the preload did not load, which is worth saying
// plainly rather than failing on an undefined member later.
export function agentBridge(): CrucibleAgent {
  const agent = window.crucible?.agent
  if (agent === undefined) {
    throw new Error('renderer: window.crucible is missing — the preload did not load')
  }
  return agent
}

export function workspaceBridge(): CrucibleWorkspace {
  const workspace = window.crucible?.workspace
  if (workspace === undefined) {
    throw new Error('renderer: window.crucible.workspace is missing — the preload did not load')
  }
  return workspace
}

export function commandsBridge(): CrucibleCommands {
  const commands = window.crucible?.commands
  if (commands === undefined) {
    throw new Error('renderer: window.crucible.commands is missing — the preload did not load')
  }
  return commands
}

export function appUpdateBridge(): CrucibleAppUpdate {
  const appUpdate = window.crucible?.appUpdate
  if (appUpdate === undefined) {
    throw new Error('renderer: window.crucible.appUpdate is missing — the preload did not load')
  }
  return appUpdate
}

export function quotaBridge(): CrucibleQuota {
  const quota = window.crucible?.quota
  if (quota === undefined) {
    throw new Error('renderer: window.crucible.quota is missing — the preload did not load')
  }
  return quota
}

export function cacheBridge(): CrucibleCache {
  const cache = window.crucible?.cache
  if (cache === undefined) {
    throw new Error('renderer: window.crucible.cache is missing — the preload did not load')
  }
  return cache
}

export function needsYouBridge(): CrucibleNeedsYou {
  const needsYou = window.crucible?.needsYou
  if (needsYou === undefined) {
    throw new Error('renderer: window.crucible.needsYou is missing — the preload did not load')
  }
  return needsYou
}

export function workflowRunsBridge(): CrucibleWorkflowRuns {
  const workflowRuns = window.crucible?.workflowRuns
  if (workflowRuns === undefined) {
    throw new Error('renderer: window.crucible.workflowRuns is missing — the preload did not load')
  }
  return workflowRuns
}

// The one value here that is allowed to be absent without anything being
// wrong: the installed app carries no instance badge, and that absence is the
// design.
export function instanceBadge(): string | undefined {
  const instance = window.crucible?.instance
  return instance === undefined || instance === '' ? undefined : instance
}

/**
 * Which OS this window is on. Absent outside a running app — a component test
 * has no OS — and the key module decides what to do with that.
 */
export function platformFact(): string | undefined {
  return window.crucible?.platform
}

export function schedulesBridge(): CrucibleSchedules {
  const schedules = window.crucible?.schedules
  if (schedules === undefined) {
    throw new Error('renderer: window.crucible.schedules is missing — the preload did not load')
  }
  return schedules
}

export function monitorsBridge(): CrucibleMonitors {
  const monitors = window.crucible?.monitors
  if (monitors === undefined) {
    throw new Error('renderer: window.crucible.monitors is missing — the preload did not load')
  }
  return monitors
}
