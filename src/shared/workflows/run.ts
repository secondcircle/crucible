// The run record, as everything above the engine sees it: the renderer's
// strip, the full-screen run view and the global runs view all read this
// shape and nothing richer. It imports only the port, which imports nothing,
// so no engine or SDK concept can ride it into the renderer.

import type { SessionId } from '../agent/port'

export type WorkflowRunId = string

// No "staged": a chained successor is started directly by the engine when its
// predecessor completes cleanly (ADR 0016), so a run that exists is running
// or done.
export type RunStatus = 'running' | 'paused' | 'complete' | 'failed' | 'cancelled'

export type RunNodeStatus =
  | 'pending'
  | 'running'
  | 'paused'
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
}

// A check-in or a blocker, already routed: what is shown is what was asked
// and where it went, never an input box (ADR 0017).
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
  // agent; absent only for a future unattended run (none is built yet).
  readonly sessionId?: SessionId
  /** The run's own worktree; every run gets one (ADR 0016). */
  readonly worktreePath?: string
  readonly branch?: string
  /** The commit the run branched from, named at kickoff. */
  readonly baseCommit?: string
  /** The commit the run's work landed on, once anything did. */
  readonly finalCommit?: string
  /** Input name -> absolute file path. */
  readonly inputs: Readonly<Record<string, string>>
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
}

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

/** The node the chip names: the running one, else the latest that isn't pending. */
export function currentNode(run: RunRecord): RunNode | undefined {
  const active = run.nodes.find(
    (node) =>
      node.status === 'running' ||
      node.status === 'blocked' ||
      node.status === 'stalled' ||
      node.status === 'paused'
  )
  if (active !== undefined) return active
  const settled = run.nodes.filter((node) => node.status !== 'pending')
  return settled.at(-1)
}

/** Live in the sense the strip cares about: it may still change. */
export function runIsLive(run: RunRecord): boolean {
  return run.status === 'running' || run.status === 'paused'
}
