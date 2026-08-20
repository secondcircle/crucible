import type { AppUpdateRequest, AppUpdateResult } from '../../shared/app-update/channels'
import type { UpdateReady } from '../../shared/app-update/service'
import type { PortRequest, PortResult } from '../../shared/agent/channels'
import type { PortEvent } from '../../shared/agent/port'
import type { CommandRequest, CommandResult } from '../../shared/commands/channels'
import type { QuotaRequest, QuotaResult } from '../../shared/quota/channels'
import type { QuotaSnapshot } from '../../shared/quota/types'
import type { WorkspaceRequest, WorkspaceResult } from '../../shared/workspace/channels'
import type { WorkspaceEvent } from '../../shared/workspace/service'

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

/** The update half, same pattern: main announces a waiting build, we ask to restart. */
export interface CrucibleAppUpdate {
  request(request: AppUpdateRequest): Promise<AppUpdateResult>
  onEvent(listener: (event: UpdateReady) => void): () => void
}

/** The quota half: ask for the cache or a refresh, hear every refresh's result. */
export interface CrucibleQuota {
  request(request: QuotaRequest): Promise<QuotaResult>
  onEvent(listener: (snapshot: QuotaSnapshot) => void): () => void
}

declare global {
  interface Window {
    crucible?: {
      agent?: CrucibleAgent
      workspace?: CrucibleWorkspace
      commands?: CrucibleCommands
      appUpdate?: CrucibleAppUpdate
      quota?: CrucibleQuota
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
