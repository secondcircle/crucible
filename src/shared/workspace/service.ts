// This module imports nothing that could smuggle Electron or Node across: it
// is a seam the renderer shares with main. Its one import is a sibling under
// the same rule.
import type { ConnectOutcome, Redacted, ResearchOutcome, ResearchStatus } from './research'

export type RunId = string

export type WorkspaceEvent =
  | { readonly type: 'run_output'; readonly runId: RunId; readonly chunk: string }
  // An absent exit code means the run was stopped rather than exiting on its
  // own; nothing is invented for it.
  | { readonly type: 'run_ended'; readonly runId: RunId; readonly exitCode?: number }
  // What the research CLI printed while a connect attempt waits on a person.
  | { readonly type: 'research_output'; readonly chunk: Redacted }

/** The events one bash run produces: the ones a run view is built from. */
export type RunEvent = Extract<WorkspaceEvent, { readonly runId: RunId }>

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

// The issue board's vocabulary. An issue is one unit of tracked work on the
// issue host, whatever that host calls it (CONTEXT.md).

export type IssueBoardAnswer =
  // No repository, or one whose remote no issue host answers for. ⌘I is dead
  // here, exactly as ⌘B is in a plain folder.
  | { readonly kind: 'noIssueHost' }
  // The host is chosen but its configuration is incomplete. ⌘I opens and the
  // board says which piece is missing and where it goes.
  | { readonly kind: 'notConfigured'; readonly missing: readonly MissingPiece[] }
  // The host is missing, unauthenticated or could not answer. The board opens
  // and says this sentence rather than showing half a list.
  | { readonly kind: 'unreachable'; readonly reason: string }
  | { readonly kind: 'board'; readonly board: IssueBoardSnapshot }

/** One piece of configuration that is not there, naming itself and its home. */
export interface MissingPiece {
  /** Exactly as it is written: "JIRA_API_TOKEN", ".crucible/jira.json". */
  readonly name: string
  /** One sentence: where it goes and what it holds. */
  readonly where: string
}

export interface IssueBoardSnapshot {
  /** ISO time collection finished; "refreshed Ns ago" derives from it. */
  readonly collectedAt: string
  // "owner/name" on GitHub, the project key on Jira: what a reference is built
  // from, either way.
  readonly repoLabel: string
  readonly host: { readonly kind: 'github' } | { readonly kind: 'jira' }
  // The host's display name for you. Never an account id and never an email:
  // no identity beyond a name crosses this seam.
  readonly login: string
  readonly rows: readonly IssueRow[]
}

export type IssueGroupId =
  | 'assignedToYou'
  | 'mentionsYou'
  | 'unclaimed'
  | 'pickedUp'
  | 'assignedToOthers'

export interface IssueLabel {
  readonly name: string
  /** Six hex digits, no `#`, as the host gives it. Absent where it gave none. */
  readonly color?: string
}

export interface IssueComment {
  readonly login: string
  readonly at: string
  readonly body: string
}

export interface IssueRow {
  readonly group: IssueGroupId
  /** The host's own number: 128 on GitHub, the 341 of `EK-341` on Jira. */
  readonly number: number
  // `crucible#128` or `EK-341` — what ⌘C copies, what the first message
  // carries, and what the picked-up fold matches on.
  readonly reference: string
  readonly title: string
  readonly url: string
  readonly labels: readonly IssueLabel[]
  /** Every assignee the host reports, by display name; empty means unclaimed. */
  readonly assignees: readonly string[]
  /** The author's display name: a GitHub login, a Jira reporter's name. */
  readonly authorLogin: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly comments: number
  /** The whole body as the host holds it; empty where the issue has none. */
  readonly body: string
  /** The newest comment, which is the one the reading pane shows. */
  readonly latestComment?: IssueComment
  // An open pull request that names this issue: one of the two ways an issue
  // is already picked up, the other being a session here.
  readonly pr?: {
    readonly number: number
    readonly state: 'open' | 'draft'
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
  // Serialized per workspace the same way, and separately: the two boards ask
  // the host different questions and neither waits on the other.
  issueBoard(workspacePath: string): Promise<IssueBoardAnswer>
  /** Opens an https URL in the OS browser. Main validates the scheme. */
  openUrl(url: string): Promise<void>

  /** Reads the research CLI's status. Never rejects: trouble is a status kind. */
  researchStatus(): Promise<ResearchStatus>
  // Connects the CLI: the browser flow with no key, the CLI's non-interactive
  // key login with one. At most one attempt runs at a time; a second call ends
  // the first, which then resolves `abandoned`. No timeout — a person is in the
  // loop, and cancelling is how the wait ends.
  researchConnect(apiKey?: string): Promise<ConnectOutcome>
  // Ends an attempt still waiting; it resolves `abandoned`. Harmless when none
  // is waiting.
  researchCancelConnect(): Promise<void>
  /** Clears the CLI's stored credential. Resolves with the status after it. */
  researchDisconnect(): Promise<ResearchOutcome>

  onEvent(listener: WorkspaceEventListener): Unsubscribe
}
