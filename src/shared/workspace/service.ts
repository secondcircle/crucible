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

// The branch board's vocabulary. "Branch" alone belongs to the session tree,
// so nothing here is named bare `Branch*` that could be mistaken for it.

export type BranchBoardAnswer =
  | { readonly kind: 'noRepository' }
  | { readonly kind: 'board'; readonly board: BranchBoardSnapshot }

export interface BranchBoardSnapshot {
  /** ISO time collection finished; "refreshed Ns ago" derives from it. */
  readonly collectedAt: string
  readonly trunk: string
  /** "owner/name" where a host answered; the workspace path where none. */
  readonly repoLabel: string
  // Absent where the repository has no host at all; unreachable where gh could
  // not answer, which is why landed then falls back to ancestry.
  readonly host?: { readonly kind: 'github'; readonly reachable: boolean }
  readonly rows: readonly BoardRow[]
}

export type BoardGroupId = 'landed' | 'inFlight' | 'waitingOnYou' | 'localOnly' | 'stale'

export type BoardDrift =
  | { readonly kind: 'counts'; readonly ahead: number; readonly behind: number }
  | { readonly kind: 'squashed' }
  | { readonly kind: 'author'; readonly login: string }

export type BoardSignal =
  | { readonly kind: 'checksFailed'; readonly count: number }
  | { readonly kind: 'checksRunning' }
  | { readonly kind: 'checksPassed' }
  | { readonly kind: 'changesRequested' }
  | { readonly kind: 'yourReview' }
  | { readonly kind: 'assignedToYou' }
  | { readonly kind: 'merged'; readonly byYou: boolean }
  | { readonly kind: 'inTrunkHistory' }

export interface BoardRow {
  readonly group: BoardGroupId
  /** The branch name, or the PR's head ref for waiting-on-you rows. */
  readonly name: string
  /** Tip author is this clone's configured identity. */
  readonly yours: boolean
  readonly checkedOut: boolean
  readonly local: boolean
  readonly onOrigin: boolean
  /** Tip commit subject; the PR title for waiting-on-you rows. */
  readonly subject: string
  readonly drift: BoardDrift
  /** ISO of the last commit, or the PR's last update for waiting rows. */
  readonly touchedAt: string
  readonly signal?: BoardSignal
  readonly pr?: {
    readonly number: number
    readonly state: 'open' | 'draft' | 'merged'
    readonly url: string
  }
}

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

  // Serialized per workspace: a call while one is in flight joins it rather
  // than starting another. A failed collection rejects; nothing is fabricated.
  branchBoard(workspacePath: string): Promise<BranchBoardAnswer>
  /** Opens an https URL in the OS browser. Main validates the scheme. */
  openUrl(url: string): Promise<void>

  onEvent(listener: WorkspaceEventListener): Unsubscribe
}
