// This module imports nothing on purpose: it is a seam the renderer shares
// with main, and any import here could smuggle Electron or Node across.

export type RunId = string

export type WorkspaceEvent =
  | { readonly type: 'run_output'; readonly runId: RunId; readonly chunk: string }
  // An absent exit code means the run was stopped rather than exiting on its
  // own; nothing is invented for it.
  | { readonly type: 'run_ended'; readonly runId: RunId; readonly exitCode?: number }

export type WorkspaceEventListener = (event: WorkspaceEvent) => void

export type Unsubscribe = () => void

/** At most 50 paths answer a search, which is what the popover can show. */
export const FILE_RESULT_LIMIT = 50

export interface WorkspaceService {
  /** Workspace-relative, gitignore-aware, and ordered the same way every time. */
  searchFiles(workspacePath: string, query: string): Promise<readonly string[]>

  /** Starts a bash run at the workspace root. Output arrives as events. */
  startRun(workspacePath: string, command: string): Promise<RunId>
  /** Terminates the run's process tree. Harmless once the run has ended. */
  stopRun(runId: RunId): Promise<void>

  onEvent(listener: WorkspaceEventListener): Unsubscribe
}
