// This module imports nothing on purpose, exactly as the agent port does: it
// is the second seam the renderer shares with main, and it must stay free of
// both Electron and Node.
//
// What lives here are OS facts about a workspace folder — its files, and
// commands run in it — which ADR 0005 keeps off the agent port.

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
  /**
   * Workspace-relative paths. Case-insensitive subsequence match, so an empty
   * query matches everything. Gitignore-aware, and `.git` is always excluded.
   * Deterministic ordering, capped at `FILE_RESULT_LIMIT`.
   */
  searchFiles(workspacePath: string, query: string): Promise<readonly string[]>

  /** Starts a bash run at the workspace root. Output arrives as events. */
  startRun(workspacePath: string, command: string): Promise<RunId>
  /** Terminates the run's process tree. Harmless once the run has ended. */
  stopRun(runId: RunId): Promise<void>

  onEvent(listener: WorkspaceEventListener): Unsubscribe
}
