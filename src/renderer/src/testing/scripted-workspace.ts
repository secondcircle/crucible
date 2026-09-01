import type {
  BranchBoardAnswer,
  IssueBoardAnswer,
  RunId,
  Unsubscribe,
  WorkspaceEvent,
  WorkspaceEventListener,
  WorkspaceService,
  WorktreeCreation
} from '../../../shared/workspace/service'
import {
  redactKeys,
  type ConnectOutcome,
  type ResearchOutcome,
  type ResearchStatus
} from '../../../shared/workspace/research'
import { rankFiles } from '../../../shared/workspace/match'

// Answers the way main does but streams nothing by itself, so a component
// test is about rendering rather than about timing.
export interface ScriptedWorkspace extends WorkspaceService {
  readonly calls: ReadonlyArray<{ readonly op: string; readonly args: readonly unknown[] }>
  /** What `searchFiles` ranks and answers from. */
  files: readonly string[]
  /** Every run this service was asked to start, oldest first. */
  readonly started: ReadonlyArray<{ readonly runId: RunId; readonly command: string }>
  /** What `isGitWorkspace` answers for any folder. */
  git: boolean
  // Held open until the test settles it, so the creating state stays put for
  // as long as the assertions need it.
  settleWorktree(created: WorktreeCreation): void
  /** How many creations are still waiting to be settled. */
  creating(): number
  /** The most recent run's id, which is the one a test drives. */
  lastRun(): RunId
  output(runId: RunId, chunk: string): void
  /** An absent exit code is a run that was stopped rather than exiting. */
  end(runId: RunId, exitCode?: number): void

  // What `branchBoard` answers, per workspace path. A path with no answer set
  // is a folder that is not a git repository, which is a normal answer.
  readonly boards: Map<string, BranchBoardAnswer>
  /** Set where a test wants a collection main could not carry out. */
  boardRefusal?: string
  // Held open where a test drives the waiting state: the promise settles when
  // the test says so.
  holdBoard?: boolean
  /** Settles a held collection with whatever the map holds now. */
  settleBoard(): void

  // What `issueBoard` answers, per workspace path. A path with no answer set
  // is a folder with no issue host, which is a normal answer.
  readonly issues: Map<string, IssueBoardAnswer>
  /** Set where a test wants a collection main could not carry out. */
  issueRefusal?: string
  /** Held the same way the branch collection is, for the waiting state. */
  holdIssues?: boolean
  /** Settles a held issue collection with whatever the map holds now. */
  settleIssues(): void
  /** Every link this service was asked to open, and opened nothing for. */
  readonly openedUrls: readonly string[]

  /** What `researchStatus` answers. */
  research: ResearchStatus
  /** Held where a test drives the checking state, as the boards are. */
  holdStatus?: boolean
  /** Settles a held status read with whatever `research` holds now. */
  settleStatus(): void
  // A connect always waits on a person, so it is always held: the test settles
  // it with the ending it wants, `abandoned` among them.
  settleConnect(outcome: ConnectOutcome): void
  /** How many connect attempts are still waiting to be settled. */
  connecting(): number
  /** Held the same way a status read is, for the log-out's waiting state. */
  holdDisconnect?: boolean
  /** What `researchDisconnect` answers; the status it holds now, by default. */
  disconnectOutcome?: ResearchOutcome
  settleDisconnect(): void
  /** What the CLI printed while a connect waits. */
  researchOutput(chunk: string): void
}

export function createScriptedWorkspace(files: readonly string[] = []): ScriptedWorkspace {
  const listeners = new Set<WorkspaceEventListener>()
  const calls: Array<{ op: string; args: readonly unknown[] }> = []
  const started: Array<{ runId: RunId; command: string }> = []
  const openedUrls: string[] = []
  let held: (() => void) | undefined
  let heldIssues: (() => void) | undefined
  const worktrees: Array<(created: WorktreeCreation) => void> = []
  const heldStatus: Array<() => void> = []
  const heldDisconnects: Array<() => void> = []
  const connects: Array<(outcome: ConnectOutcome) => void> = []
  let minted = 0

  function emit(event: WorkspaceEvent): void {
    for (const listener of [...listeners]) listener(event)
  }

  const service: ScriptedWorkspace = {
    calls,
    files,
    started,
    boards: new Map<string, BranchBoardAnswer>(),
    openedUrls,

    branchBoard(workspacePath: string): Promise<BranchBoardAnswer> {
      calls.push({ op: 'branchBoard', args: [workspacePath] })
      if (service.boardRefusal !== undefined) {
        return Promise.reject(new Error(service.boardRefusal))
      }
      const answer = (): BranchBoardAnswer =>
        service.boards.get(workspacePath) ?? { kind: 'noRepository' }
      if (service.holdBoard !== true) return Promise.resolve(answer())
      return new Promise<BranchBoardAnswer>((resolve) => {
        held = () => resolve(answer())
      })
    },

    settleBoard(): void {
      const settle = held
      held = undefined
      settle?.()
    },

    issues: new Map<string, IssueBoardAnswer>(),

    issueBoard(workspacePath: string): Promise<IssueBoardAnswer> {
      calls.push({ op: 'issueBoard', args: [workspacePath] })
      if (service.issueRefusal !== undefined) {
        return Promise.reject(new Error(service.issueRefusal))
      }
      const answer = (): IssueBoardAnswer =>
        service.issues.get(workspacePath) ?? { kind: 'noIssueHost' }
      if (service.holdIssues !== true) return Promise.resolve(answer())
      return new Promise<IssueBoardAnswer>((resolve) => {
        heldIssues = () => resolve(answer())
      })
    },

    settleIssues(): void {
      const settle = heldIssues
      heldIssues = undefined
      settle?.()
    },

    openUrl(url: string): Promise<void> {
      calls.push({ op: 'openUrl', args: [url] })
      openedUrls.push(url)
      return Promise.resolve()
    },

    git: true,

    searchFiles(directory: string, query: string): Promise<readonly string[]> {
      calls.push({ op: 'searchFiles', args: [directory, query] })
      return Promise.resolve(rankFiles(service.files, query))
    },

    isGitWorkspace(workspacePath: string): Promise<boolean> {
      calls.push({ op: 'isGitWorkspace', args: [workspacePath] })
      return Promise.resolve(service.git)
    },

    createWorktree(workspacePath: string): Promise<WorktreeCreation> {
      calls.push({ op: 'createWorktree', args: [workspacePath] })
      return new Promise<WorktreeCreation>((resolve) => {
        worktrees.push(resolve)
      })
    },

    startRun(directory: string, command: string): Promise<RunId> {
      calls.push({ op: 'startRun', args: [directory, command] })
      minted += 1
      const runId = `scripted-run-${minted}`
      started.push({ runId, command })
      return Promise.resolve(runId)
    },

    stopRun(runId: RunId): Promise<void> {
      calls.push({ op: 'stopRun', args: [runId] })
      return Promise.resolve()
    },

    research: { kind: 'signedOut', version: redactKeys('1.23.3') },

    researchStatus(): Promise<ResearchStatus> {
      calls.push({ op: 'researchStatus', args: [] })
      if (service.holdStatus !== true) return Promise.resolve(service.research)
      return new Promise<ResearchStatus>((resolve) => {
        heldStatus.push(() => resolve(service.research))
      })
    },

    settleStatus(): void {
      const settle = heldStatus.shift()
      if (settle === undefined) throw new Error('no status read is waiting')
      settle()
    },

    researchConnect(apiKey?: string): Promise<ConnectOutcome> {
      calls.push({ op: 'researchConnect', args: apiKey === undefined ? [] : [apiKey] })
      return new Promise<ConnectOutcome>((resolve) => {
        connects.push(resolve)
      })
    },

    settleConnect(outcome: ConnectOutcome): void {
      const settle = connects.shift()
      if (settle === undefined) throw new Error('no connect attempt is waiting')
      settle(outcome)
    },

    connecting: () => connects.length,

    researchCancelConnect(): Promise<void> {
      calls.push({ op: 'researchCancelConnect', args: [] })
      return Promise.resolve()
    },

    researchDisconnect(): Promise<ResearchOutcome> {
      calls.push({ op: 'researchDisconnect', args: [] })
      const answer = (): ResearchOutcome =>
        service.disconnectOutcome ?? { kind: 'settled', status: service.research }
      if (service.holdDisconnect !== true) return Promise.resolve(answer())
      return new Promise<ResearchOutcome>((resolve) => {
        heldDisconnects.push(() => resolve(answer()))
      })
    },

    settleDisconnect(): void {
      const settle = heldDisconnects.shift()
      if (settle === undefined) throw new Error('no log-out is waiting')
      settle()
    },

    researchOutput(chunk: string): void {
      emit({ type: 'research_output', chunk: redactKeys(chunk) })
    },

    onEvent(listener: WorkspaceEventListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    settleWorktree(created: WorktreeCreation): void {
      const settle = worktrees.shift()
      if (settle === undefined) throw new Error('no worktree creation is waiting')
      settle(created)
    },

    creating: () => worktrees.length,

    lastRun(): RunId {
      const last = started.at(-1)
      if (last === undefined) throw new Error('no run has been started')
      return last.runId
    },

    output(runId, chunk) {
      emit({ type: 'run_output', runId, chunk })
    },

    end(runId, exitCode) {
      emit(exitCode === undefined ? { type: 'run_ended', runId } : { type: 'run_ended', runId, exitCode })
    }
  }

  return service
}
