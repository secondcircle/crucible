import type { ObservedCacheMiss } from '../../shared/agent/adapter'
import type { BoundMonitorTools } from '../../shared/agent/monitor-tools'
import type { TranscriptItem, Unsubscribe } from '../../shared/agent/port'
import type { LoadedSkill } from '../skills/service'

// The engine's one seam onto agents: a node is a fresh session with two
// injected completion tools, and everything the engine needs of it is here.
// The SDK factory backs it with π; tests hand in scripted sessions, so the
// whole node loop — nudges, validation, blockers, revisions — runs against
// fakes and `npm test` constructs no SDK session at all.
//
// Nothing in a request is prompt text the engine wrote. The system prompt is
// the workflow's, verbatim or absent, and the factory opens it with
// Crucible's node base; the task arrives through `prompt()`, verbatim; how a
// node finishes is carried by the descriptions of the two injected tools,
// which belong to the tools and not to any prompt.

export interface NodeCompletion {
  readonly summary: string
  readonly verdict?: unknown
}

export interface NodeBlocker {
  readonly reason: string
  readonly details?: string
  /** Path of a document the orchestrator should read to decide. */
  readonly artifact?: string
}

export interface NodeSessionRequest {
  /** The run's worktree: where the node's tools work. */
  readonly cwd: string
  // Where this run keeps its node sessions, so one survives the app quitting
  // and can be reopened. Crucible's own directory; nothing of π's.
  readonly sessionDir: string
  // Reopen the session this token names rather than starting a fresh one:
  // the node carries on from its last turn, with everything it had said and
  // been told. A token the factory cannot open is an error, and the engine
  // falls back to running the node again from its prompt.
  readonly resumeToken?: string
  /** "provider/model-id:thinkingLevel". */
  readonly model: string
  // The node this session is for, by its id in the run. For logs and for
  // fakes that script one node differently from another; it reaches no
  // prompt.
  readonly nodeId: string
  /** The run and the workflow the node belongs to, which is how its rule firings are filed. */
  readonly runId: string
  readonly workflow: string
  // The workflow's own system prompt for this node, sent whole and unchanged
  // after Crucible's node base. Absent means the base alone; the model's
  // stock prompt is never sent. Either way the runtime still appends what
  // the worktree's AGENTS.md files say.
  readonly system?: string
  /** Built-in tool names the node gets, complete_node and raise_blocker aside. */
  readonly tools: readonly string[]
  // The node's own monitor tools, mounted beside complete_node and
  // raise_blocker so a declared tool list cannot take them away. Absent means
  // this node cannot wait on anything.
  readonly monitors?: BoundMonitorTools
  // Already resolved and already narrowed to what the node's spec asked for:
  // a node is offered nothing this does not name.
  readonly skills?: readonly LoadedSkill[]
  /**
   * The node's declared verdict schema. When present, complete_node requires
   * a `verdict` argument matching it, enforced at the tool boundary so a bad
   * call fails in the model's face instead of one engine turn later.
   */
  readonly verdictSchema?: Record<string, unknown>
  /** The agent called complete_node; the return is the tool's answer text. */
  readonly onComplete: (completion: NodeCompletion) => string
  /** The agent called raise_blocker; same contract. */
  readonly onBlocker: (blocker: NodeBlocker) => string
  // A cache miss on one of this node's turns, detected the way a session's
  // is. A run is observed, never conversed with: this reaches the ledger and
  // the run's chip and becomes no message to anybody.
  readonly onCacheMiss?: (miss: ObservedCacheMiss) => void
}

export interface NodeSessionStats {
  readonly toolCalls: number
  /** Billed dollars of the session so far. */
  readonly cost?: number
  /** Context-window usage, 0–100. */
  readonly contextPercent?: number
}

export interface NodeSession {
  // What this session can be reopened from, opaque to everything above the
  // factory that made it. Absent when the session leaves nothing behind —
  // then a node that stops can only be run again from its prompt.
  token(): string | undefined
  /** One turn: resolves when the turn ends, however it ends. Never rejects
   *  for model trouble — a failed turn ends quietly and the loop nudges. */
  prompt(text: string): Promise<void>
  /** Abort the live turn; the pending prompt() then resolves. */
  abort(): Promise<void>
  isStreaming(): boolean
  stats(): NodeSessionStats
  /** The session so far, in the chat pane's own shape. */
  transcript(): readonly TranscriptItem[]
  /** Streaming liveness: fires on any activity, with a "doing X…" line. */
  onActivity(listener: (now: string | undefined) => void): Unsubscribe
  dispose(): void
}

export interface NodeSessionFactory {
  start(request: NodeSessionRequest): Promise<NodeSession>
}
