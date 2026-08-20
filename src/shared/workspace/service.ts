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

// What one creation attempt produced. A failure is a value rather than a
// throw, because the whole of the output has to reach the screen intact.
export type WorktreeCreation =
  | {
      readonly ok: true
      /** Absolute, and an existing directory. */
      readonly path: string
      /** Absent when the branch could not be read. */
      readonly branch?: string
    }
  | {
      readonly ok: false
      /** A first line naming what failed, then the combined output verbatim. */
      readonly output: string
    }

export interface WorkspaceService {
  // Relative to the directory it is given, gitignore-aware, and ordered the
  // same way every time. The directory is the session's, worktree included.
  searchFiles(directory: string, query: string): Promise<readonly string[]>

  /** Whether the folder is inside a git working tree. A worktree counts. */
  isGitWorkspace(workspacePath: string): Promise<boolean>

  // Runs the workspace's own `.crucible/worktree` when it has one, and plain
  // git when it does not. Nothing is ever cleaned up afterwards.
  createWorktree(workspacePath: string): Promise<WorktreeCreation>

  /** Starts a bash run in the directory it is given. Output arrives as events. */
  startRun(directory: string, command: string): Promise<RunId>
  /** Terminates the run's process tree. Harmless once the run has ended. */
  stopRun(runId: RunId): Promise<void>

  onEvent(listener: WorkspaceEventListener): Unsubscribe
}
