import type { ObservedCacheMiss } from '../../shared/agent/adapter'
import type { BoundMonitorTools } from '../../shared/agent/monitor-tools'
import type { TranscriptItem, Unsubscribe } from '../../shared/agent/port'
import type { LoadedSkill } from '../skills/service'

// The engine's one seam onto agents: a node is a fresh session with two
// injected completion tools, and everything the engine needs of it is here.
// The SDK factory backs it with π; tests hand in scripted sessions, so the
// whole node loop — nudges, validation, blockers, revisions — runs against
// fakes and `npm test` constructs no SDK session at all.

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
  /** "provider/model-id:thinkingLevel". */
  readonly model: string
  /** The node's role text; the factory appends the standing prompt itself. */
  readonly rolePrompt: string
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
