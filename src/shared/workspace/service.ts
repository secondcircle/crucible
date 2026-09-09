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

// The issue board's vocabulary. An issue is one unit of tracked work on the
// issue host, whatever that host calls it (CONTEXT.md).

export type IssueBoardAnswer =
  // No repository, or one whose remote no issue host answers for. ⌘I is dead
  // here.
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
  issueBoard(workspacePath: string): Promise<IssueBoardAnswer>
  /** Opens an https URL in the OS browser. Main validates the scheme. */
  openUrl(url: string): Promise<void>

  /** Reads the research CLI's status. Never rejects: trouble is a status kind. */
  researchStatus(): Promise<ResearchStatus>
  // A second call ends the attempt in flight, which then resolves `abandoned`.
  // No timeout: a person is in the loop, and cancelling is how the wait ends.
  researchConnect(apiKey?: string): Promise<ConnectOutcome>
  // Ends an attempt still waiting; it resolves `abandoned`. Harmless when none
  // is waiting.
  researchCancelConnect(): Promise<void>
  /** Clears the CLI's stored credential. Resolves with the status after it. */
  researchDisconnect(): Promise<ResearchOutcome>

  onEvent(listener: WorkspaceEventListener): Unsubscribe
}
