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

// The two ways a stopped node goes back to work, in CONTEXT.md's words:
// Resume continues it from its last turn, a Clean restart runs it again from
// its prompt with no memory of the attempt that stopped.
export type ResumeKind = 'continue' | 'clean-restart'

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

// What a node is waiting on, while it is. Present only on a node whose turn
// ended with a monitor of its own live and whose wake has not started its next
// turn; the engine writes it at the wait's start and deletes it before any
// other status write. `status` stays 'running': a wait is not a stop.
export interface NodeWait {
  readonly monitorId: string
  /** The description verbatim: the run chip's and the node header's words. */
  readonly description: string
  /** ISO of the monitor's `setAt`: how long the chip says it has waited. */
  readonly since: string
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
  // What this node is waiting on, present only while it genuinely is. The
  // description is a copy of an immutable fact, which is what lets every run
  // surface keep reading `RunRecord` and nothing richer.
  readonly waitingOn?: NodeWait
  // The node's own agent session, as the thing that opened it names it:
  // opaque here and everywhere above the engine. What Resume reopens to
  // continue a node from its last turn. Absent on a node that never opened
  // one, and on records written before sessions outlived the app.
  readonly sessionToken?: string
}

// A result a workflow recorded under a key of its own, so a resumed run is
// handed it back instead of doing the work again: the answer to a check-in,
// the output of a command, a commit hash. The value is whatever the workflow
// produced, as JSON.
export interface RunEffect {
  readonly key: string
  readonly value: unknown
  /** ISO instant the run first produced it. */
  readonly at: string
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
  // What this run has recorded besides its nodes, in the order it recorded
  // them. Replay reads it; nothing else does.
  readonly effects?: readonly RunEffect[]
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

// Resume is total over every stop short of completion, and refuses the two
// states with nothing to resume — complete, and already running — naming the
// run and where it stands. A second resume racing the first reads the run as
// `running` and is refused by this same sentence.
export function resumeRefusal(runId: WorkflowRunId, status: RunStatus): string {
  return `The run "${runId}" is ${status}; there is nothing to resume.`
}

/** Whether Resume has anything to act on: every stop short of completion. */
export function runCanResume(run: RunRecord): boolean {
  return run.status !== 'complete' && run.status !== 'running'
}

// One node, several records: a revision — a clean restart, or a held-open
// node revised — leaves the record it follows exactly where it stopped and
// puts the work on `<id>·rN`. The engine acts on the furthest record of that
// chain and on no other one (engine.ts `runNode`), so anything that says what
// a node is or what a resume will do to it has to read the chain rather than
// the record. The id convention is the whole mechanism, and this module is
// where it is spelled: the engine reads it from here too, so there is one
// answer and not two.
const REVISION_MARK = '\u00b7r'

/** A revision id split into the node it belongs to and which round it is. */
interface Revision {
  readonly base: string
  readonly round: number
}

function revisionOf(recordId: string): Revision | undefined {
  const at = recordId.lastIndexOf(REVISION_MARK)
  if (at <= 0) return undefined
  const round = recordId.slice(at + REVISION_MARK.length)
  if (!/^\d+$/.test(round)) return undefined
  return { base: recordId.slice(0, at), round: Number(round) }
}

/** The node a record belongs to: `gate·r1` is a record of `gate`. */
export function baseNodeId(recordId: string): string {
  return revisionOf(recordId)?.base ?? recordId
}

/**
 * Every record one node's session has taken, in the order it took them: the
 * node's own id first, then `id·r1`, `id·r2` … Generic over the record shape
 * so the engine's own mutable nodes walk the same rule the surfaces do.
 */
export function nodeChain<T extends { readonly id: string }>(
  nodes: readonly T[],
  id: string
): readonly T[] {
  const revised = nodes
    .map((node) => ({ node, revision: revisionOf(node.id) }))
    .filter(
      (candidate): candidate is { node: T; revision: Revision } =>
        candidate.revision?.base === id
    )
    .sort((left, right) => left.revision.round - right.revision.round)
  const base = nodes.find((node) => node.id === id)
  return [...(base === undefined ? [] : [base]), ...revised.map((candidate) => candidate.node)]
}

/** One node as its records tell it, which is how the engine reads it. */
export interface NodeChain {
  /** The node's own id: the base record's, and what names its revisions. */
  readonly id: string
  /** Its records, base first, then each revision in order. */
  readonly records: readonly RunNode[]
  // The record the engine acts on: the furthest one its session took. What
  // every surface must speak about, because the records behind it are history
  // the engine will never touch again.
  readonly furthest: RunNode
  // The furthest record that completed, if any. A resume hands its result
  // back instead of putting the node to work at all, whichever record of the
  // chain carried it.
  readonly complete?: RunNode
}

/** The run's nodes as nodes rather than records, in the order they appear. */
export function nodeChains(run: RunRecord): readonly NodeChain[] {
  const bases: string[] = []
  for (const node of run.nodes) {
    const base = baseNodeId(node.id)
    if (!bases.includes(base)) bases.push(base)
  }
  return bases.map((id) => {
    const records = nodeChain(run.nodes, id)
    const complete = records.filter((record) => record.status === 'complete').at(-1)
    return {
      id,
      records,
      // `bases` comes from the records themselves, so every chain has one.
      furthest: records[records.length - 1],
      ...(complete === undefined ? {} : { complete })
    }
  })
}

// The nodes a resume puts back to work: one record per node — the furthest of
// its chain — whenever that record stopped short of finishing, whichever stop
// it was. A node any record of whose chain completed is replayed instead, and
// a node that never started is simply run. The records a revision superseded
// are nobody's work: the engine leaves them as they stopped and never reopens
// their sessions.
export function stoppedNodes(run: RunRecord): readonly RunNode[] {
  return nodeChains(run)
    .filter((chain) => chain.complete === undefined && isStopped(chain.furthest))
    .map((chain) => chain.furthest)
}

/**
 * The two acts a resume can perform on one node, and the only two: carry its
 * session on from its last turn, or run it again from its prompt beside the
 * record that stopped. Every split in this module — the nodes a resume puts
 * back to work (`resumePlan`), the revisions a quit cut down
 * (`cutRevisions`) — comes out in this shape, on the one fact the engine
 * acts on: whether there is a session token to reopen. One record per node,
 * the one the engine acts on, so no surface can promise a different act from
 * the one the engine performs.
 */
export interface ResumePlan {
  /** Nodes that carry on from their last turn, spending nothing twice. */
  readonly continued: readonly RunNode[]
  /** Nodes that run again from their prompt, beside the attempt that stopped. */
  readonly restarted: readonly RunNode[]
}

/**
 * The records of nodes the quit caught mid-revision: the chain's furthest
 * record stopped, but a record behind it completed. The engine puts none of
 * these back to work itself — it hands the completion back, and the
 * workflow's re-issued `revise()` acts on that record — so they are never
 * `stoppedNodes`.
 *
 * Which act that is written in the same place the engine reads it: the
 * session named by the chain's **completed** record, because that is the
 * token `replayedHandle.revise` reopens. The cut revision record never
 * carries one of its own. With a token the node carries on in the session it
 * was working in; without one — every record main wrote, before sessions
 * outlived the app — `revise()` opens a fresh session from the node's whole
 * prompt, which is a from-the-prompt re-run and has to be named as one.
 */
export function cutRevisions(run: RunRecord): ResumePlan {
  const cut = nodeChains(run).filter(
    (chain) =>
      chain.complete !== undefined &&
      chain.furthest !== chain.complete &&
      isStopped(chain.furthest)
  )
  return {
    continued: cut
      .filter((chain) => chain.complete?.sessionToken !== undefined)
      .map((chain) => chain.furthest),
    restarted: cut
      .filter((chain) => chain.complete?.sessionToken === undefined)
      .map((chain) => chain.furthest)
  }
}

function isStopped(node: RunNode): boolean {
  return (
    node.status === 'interrupted' ||
    node.status === 'failed' ||
    node.status === 'blocked' ||
    node.status === 'stalled' ||
    node.status === 'paused' ||
    node.status === 'running'
  )
}

/**
 * What a resume will do to each node it puts back to work, split the one way
 * the engine splits them: a node whose own session is on disk continues from
 * its last turn, and one with no session recorded — a record written before
 * sessions outlived the app — runs again from its prompt, as does every node
 * of a clean restart.
 */
export function resumePlan(run: RunRecord, kind: ResumeKind): ResumePlan {
  const stopped = stoppedNodes(run)
  const continued =
    kind === 'clean-restart' ? [] : stopped.filter((node) => node.sessionToken !== undefined)
  return { continued, restarted: stopped.filter((node) => !continued.includes(node)) }
}

/** Whether a message in a session's transcript is a run talking, not a human. */
export function isRunMessage(text: string): boolean {
  return text.startsWith(RUN_MESSAGE_PREFIX)
}

/**
 * The last moment any node of this run was seen doing something, ISO. Absent
 * when no node ever recorded activity.
 *
 * Two readers, one definition: it is the most honest stop time a swept record
 * can be given, and it is what a stopped run says about when its workspace was
 * last used. Two copies would drift, and a workspace in the wrong band is a
 * silent failure.
 */
export function latestNodeActivity(run: Pick<RunRecord, 'nodes'>): string | undefined {
  const stamps = run.nodes
    .flatMap((node) => [node.lastActivityAt, node.endedAt])
    .filter((at): at is string => at !== undefined)
  if (stamps.length === 0) return undefined
  return stamps.reduce((latest, at) => (Date.parse(at) > Date.parse(latest) ? at : latest))
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
  // Each node as its furthest record, in record order: a record a revision
  // superseded is history, and naming it would tell a session the run stands
  // somewhere it left long ago.
  const speaking = nodeChains(run)
    .map((chain) => chain.furthest)
    .sort((left, right) => run.nodes.indexOf(left) - run.nodes.indexOf(right))
  const active = speaking.find(
    (node) =>
      node.status === 'running' ||
      node.status === 'blocked' ||
      node.status === 'stalled' ||
      node.status === 'paused'
  )
  if (active !== undefined) return active
  // The node the quit cut down is what an interrupted run is about, so it is
  // the node every surface names for one — but only while nothing else is
  // working, because a clean restart leaves that record where it stopped.
  const cut = speaking.find((node) => node.status === 'interrupted')
  if (cut !== undefined) return cut
  const settled = speaking.filter((node) => node.status !== 'pending')
  return settled.at(-1)
}

/** Live in the sense the strip cares about: it may still change. */
export function runIsLive(run: RunRecord): boolean {
  return run.status === 'running' || run.status === 'paused'
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
