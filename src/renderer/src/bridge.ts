import type { PortRequest, PortResult } from '../../shared/agent/channels'
import type { PortEvent } from '../../shared/agent/port'
import type { WorkspaceRequest, WorkspaceResult } from '../../shared/workspace/channels'
import type { WorkspaceEvent } from '../../shared/workspace/service'

// The one module in the renderer that may name `window.crucible`. It holds no
// state and knows nothing of either seam's meaning: it says what the preload
// exposes and complains loudly when the preload did not load.

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

declare global {
  interface Window {
    crucible?: { agent?: CrucibleAgent; workspace?: CrucibleWorkspace }
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
