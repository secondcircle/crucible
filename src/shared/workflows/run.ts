// The run record, as everything above the engine sees it: the renderer's
// strip, the full-screen run view and the global runs view all read this
// shape and nothing richer. It imports only the port, which imports nothing,
// so no engine or SDK concept can ride it into the renderer.

import type { SessionId } from '../agent/port'

export type WorkflowRunId = string

// No "staged": a chained successor is started directly by the engine when its
// predecessor completes cleanly, so a run that exists is running
// or done.
//
// `interrupted` is the app quitting out from under a run, which is a different
// fact from `failed` — the work going wrong — and the only status Resume acts
// on. One value, so nothing downstream has to parse an error string to tell
// the two apart.
export type RunStatus =
  | 'running'
  | 'paused'
  | 'interrupted'
  | 'complete'
  | 'failed'
  | 'cancelled'

export type RunNodeStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'interrupted'
  | 'complete'
  | 'failed'
  | 'blocked'
  | 'stalled'

export interface RunArtifact {
  /** Short name, e.g. "spec". */
  readonly name: string
  /** Absolute path on disk, in the run's own directory rather than the repo. */
  readonly path: string
  /** One-line human description. */
  readonly desc: string
  // ISO instant the engine first saw the file on disk, non-empty. Absent means
  // the file has not been written yet — a declared output is recorded from the
  // moment its node starts.
  readonly writtenAt?: string
}

// A check-in or a blocker, already routed: what is shown is what was asked
// and where it went, never an input box.
export interface RunQuestion {
  readonly reason: string
  /** The node that raised it; absent for a workflow-level check-in. */
  readonly nodeId?: string
  /** ISO. */
  readonly raisedAt: string
  readonly answeredAt?: string
  readonly answer?: string
}

export interface RunNode {
  readonly id: string
  readonly status: RunNodeStatus
  /** Node ids this node depends on (producers of the artifacts it reads). */
  readonly parents: readonly string[]
  /** "provider/model-id:thinkingLevel". */
  readonly model?: string
  readonly reads: readonly RunArtifact[]
  readonly artifacts: readonly RunArtifact[]
  readonly verdict?: unknown
  /** The agent's completion summary. */
  readonly summary?: string
  readonly error?: string
  /** ISO. */
  readonly startedAt?: string
  readonly endedAt?: string
  readonly lastActivityAt?: string
  /** What the node's agent is doing right now, for live display. */
  readonly now?: string
  readonly toolCalls?: number
  /** Context-window usage of the node's session, 0–100. */
  readonly contextPercent?: number
  /** Billed dollars of the node's session so far. */
  readonly cost?: number
  // Cache misses observed on this node's turns. What makes a sub-agent's
  // misses visible while nobody is watching that run.
  readonly cacheMisses?: number
}

export interface RunRecord {
  readonly id: WorkflowRunId
  /** The workflow's resolved name, which is its file name. */
  readonly workflow: string
  readonly status: RunStatus
  /** The workspace checkout the run belongs to. */
  readonly workspacePath: string
  /** What the global view groups by. */
  readonly workspaceName: string
  // The orchestrator session. Every question and the completion go to its
  // agent; absent only for an unattended run — one a schedule fired, which
  // has no orchestrator until a session adopts it.
  readonly sessionId?: SessionId
  // Fired from the schedule surface: a clock fire or the board's Run now. It
  // marks where the run came from and changes nothing about what a run is.
  // Runs started by agents or any other path never carry it.
  readonly scheduled?: true
  /** The run's own worktree; every run gets one. */
  readonly worktreePath?: string
  readonly branch?: string
  /** The commit the run branched from, named at kickoff. */
  readonly baseCommit?: string
  /** The commit the run's work landed on, once anything did. */
  readonly finalCommit?: string
  /** Input name -> absolute file path. */
  readonly inputs: Readonly<Record<string, string>>
  // Input name -> the workflow's one-line description of it. Absent on records
  // written before descriptions were kept.
  readonly inputDescs?: Readonly<Record<string, string>>
  /** The latest question, answered or not; `waiting` says which. */
  readonly question?: RunQuestion
  /** True while somebody owes the run an answer. */
  readonly waiting?: boolean
  readonly nodes: readonly RunNode[]
  readonly outputs?: Readonly<Record<string, unknown>>
  readonly error?: string
  /** Predecessor run id, for a chained successor. */
  readonly after?: string
  /** ISO. */
  readonly createdAt: string
  readonly startedAt?: string
  readonly endedAt?: string
  // ISO instant the user dismissed the run: cleared a settled run that was
  // asking for attention it no longer deserves. Set only on a settled run,
  // never cleared, never set twice — the first stamp stands.
  readonly dismissedAt?: string
  // The run's own directory, holding run.json, artifacts/ and transcripts/.
  // Carried on the record so a prompt can name it without the renderer
  // guessing at storage layout; the store backfills it at load.
  readonly dir?: string
  // The orchestrator has not yet been told this run was interrupted. Set only
  // by the startup sweep and only when `sessionId` is present; cleared by the
  // first message about this run that reaches its orchestrator. Never set on a
  // run with no orchestrator. What the notice says is composed at delivery
  // from the record, so nothing stored here can go stale.
  readonly noticePending?: true
}

// What a record that outlived its engine is told it is. Spelled once: the
// sweep writes it onto the run and its cut nodes, the notice to the
// orchestrator says it again, and the run view's banner is drawn from it.
export const INTERRUPTED_MESSAGE =
  'Crucible quit while this run was working, so it stopped where it stood. ' +
  'Its worktree is left as it stands.'

// Every message a run sends its orchestrator opens with this, and three
// things downstream read it back: the fake orchestrator recognizes a run
// speaking, the titler declines to name a session after one, and a human
// scanning a transcript sees at a glance which messages nobody typed. It is a
// protocol, so it is spelled once.
export const RUN_MESSAGE_PREFIX = '⚑ Crucible run'

/** Opens a message from a run to its orchestrator, and marks it as one. */
export function runMessageHeader(run: Pick<RunRecord, 'id' | 'workflow'>): string {
  return `${RUN_MESSAGE_PREFIX} ${run.id} (${run.workflow})`
}

// Both flavors refuse the same way, so the sentence is spelled once: a live
// run is stopped, never cleared, and the UI offers Cancel there instead.
export function dismissRefusal(runId: WorkflowRunId): string {
  return `The run "${runId}" is still working, so there is nothing to dismiss — cancel it instead.`
}

// Resume is total over the two stopped states and refuses every other one,
// naming the run and where it stands. A second resume racing the first reads
// the run as `running` and is refused by this same sentence.
export function resumeRefusal(runId: WorkflowRunId, status: RunStatus): string {
  return `The run "${runId}" is ${status}; there is nothing to resume.`
}

/** Whether a message in a session's transcript is a run talking, not a human. */
export function isRunMessage(text: string): boolean {
  return text.startsWith(RUN_MESSAGE_PREFIX)
}

/** Billed dollars across the run's nodes, which is what the chip shows. */
export function runCost(run: RunRecord): number | undefined {
  const costs = run.nodes
    .map((node) => node.cost)
    .filter((cost): cost is number => cost !== undefined)
  if (costs.length === 0) return undefined
  return costs.reduce((sum, cost) => sum + cost, 0)
}

/** Cache misses across the run's nodes, which is what the chip's mark shows. */
export function runCacheMisses(run: RunRecord): number {
  return run.nodes.reduce((sum, node) => sum + (node.cacheMisses ?? 0), 0)
}

/** The node the chip names: the running one, else the latest that isn't pending. */
export function currentNode(run: RunRecord): RunNode | undefined {
  const active = run.nodes.find(
    (node) =>
      node.status === 'running' ||
      node.status === 'blocked' ||
      node.status === 'stalled' ||
      node.status === 'paused' ||
      // The node the quit cut down is what an interrupted run is about, so it
      // is the node every surface names for one.
      node.status === 'interrupted'
  )
  if (active !== undefined) return active
  const settled = run.nodes.filter((node) => node.status !== 'pending')
  return settled.at(-1)
}

/** Live in the sense the strip cares about: it may still change. */
export function runIsLive(run: RunRecord): boolean {
  return run.status === 'running' || run.status === 'paused'
}

// The nodes the quit cut down, in record order: what Resume re-runs. There is
// no field for them — a status is the whole truth, and a fan-out interrupted
// mid-flight is several of them.
export function interruptedNodes(run: RunRecord): readonly RunNode[] {
  return run.nodes.filter((node) => node.status === 'interrupted')
}

/**
 * Parked: a run with no orchestrator to hear it, stopped on something. It has
 * no `sessionId`, has not been dismissed, and is either waiting on an answer
 * (a question, a blocker, a stall) or has settled `failed` or `interrupted`.
 * A parked run waits indefinitely at no cost until a session adopts it or the
 * user dismisses it. Clean completions and cancellations are never parked.
 */
export function runIsParked(run: RunRecord): boolean {
  if (run.sessionId !== undefined) return false
  if (run.dismissedAt !== undefined) return false
  // Interrupted sits here for the same reason failed does: only a deliberate
  // act moves it, and with no orchestrator that act has to be found.
  if (run.status === 'failed' || run.status === 'interrupted') return true
  return runIsLive(run) && run.waiting === true
}
