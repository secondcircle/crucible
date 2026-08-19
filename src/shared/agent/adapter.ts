import type {
  HistoryMatch,
  ModelId,
  ModelInfo,
  SessionId,
  ThinkingLevel,
  TranscriptItem,
  TurnId,
  Unsubscribe
} from './port'

/**
 * The adapter contract: everything conversation-side, implemented twice — by
 * the fake adapter and by the SDK adapter.
 *
 * It is the lower half of main's agent port. The upper half is the shell store,
 * which owns workspaces, curated membership and activation and is identical in
 * both launch flavors (A27); an adapter never sees any of that. What an adapter
 * owns is a conversation per `SessionId`, its history, the models it can reach,
 * and the turns it runs.
 *
 * Two rules shape the whole of it:
 *
 * - **Crucible's identities go down, never π's up** (ADR 0004). Every operation
 *   is keyed by a Crucible `SessionId` and a workspace folder. What an adapter
 *   hands back to describe where a conversation lives is a *binding token*: an
 *   opaque string the shell store persists so a later launch can rebind, and
 *   which nothing above this seam interprets, displays or edits.
 * - **Turn ids come from above.** Main mints a `TurnId` when it accepts a
 *   prompt and hands it down, so no id has to be translated at this seam and an
 *   adapter cannot start a turn nobody asked for. Single flight per session is
 *   main's rule too: an adapter driven straight from a test serves whatever it
 *   is asked.
 */

/** What an adapter says about a conversation it has just bound to a session. */
export interface Binding {
  /** Opaque; the store persists it, and only this adapter reads it. */
  readonly token: string
  /** The model actually in effect — after any fallback (MO-4). */
  readonly model?: ModelId
  readonly thinkingLevel?: ThinkingLevel
  /**
   * Whether an existing conversation was found and restored. False means a
   * fresh one was bound instead — which is the honest answer for an in-memory
   * adapter after a relaunch (FA-6), and the reason the token may have changed.
   */
  readonly restored: boolean
}

/** What a caller asks for when it wants a session bound to a conversation. */
export interface BindRequest {
  readonly sessionId: SessionId
  /** The workspace folder the agent works in (A17). */
  readonly workspacePath: string
  /** A token from an earlier launch. Absent means: bind a fresh conversation. */
  readonly token?: string
  /** Crucible's last model selection, honored when the model is available. */
  readonly preferredModel?: ModelId
  readonly preferredThinkingLevel?: ThinkingLevel
}

/** What a caller asks for when resuming a conversation from history. */
export interface ResumeRequest {
  readonly sessionId: SessionId
  readonly workspacePath: string
  /** An opaque `ref` from `searchHistory`. */
  readonly ref: string
}

/**
 * Everything an adapter says. The turn events are the port's own, minus the
 * `state` event that only main can produce; `usage` is the one extra, because
 * usage is an adapter fact that main folds into the snapshot (TB-2).
 */
export type AdapterEvent =
  | { readonly type: 'turn_started'; readonly sessionId: SessionId; readonly turnId: TurnId }
  | {
      readonly type: 'text_delta'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      readonly delta: string
    }
  | {
      readonly type: 'thinking_delta'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      readonly delta: string
    }
  | {
      readonly type: 'tool_started'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      readonly callId: string
      readonly name: string
      readonly summary: string
    }
  | {
      readonly type: 'tool_output'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      readonly callId: string
      readonly chunk: string
    }
  | {
      readonly type: 'tool_ended'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      readonly callId: string
      readonly ok: boolean
      readonly output: string
    }
  | { readonly type: 'turn_ended'; readonly sessionId: SessionId; readonly turnId: TurnId }
  | { readonly type: 'turn_cancelled'; readonly sessionId: SessionId; readonly turnId: TurnId }
  | {
      readonly type: 'turn_error'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      readonly message: string
    }
  | {
      readonly type: 'usage'
      readonly sessionId: SessionId
      readonly usedTokens: number
      readonly contextWindow: number
    }

export type AdapterEventListener = (event: AdapterEvent) => void

/** The conversation side of the agent port, as both flavors implement it. */
export interface ConversationAdapter {
  /**
   * Bind a session to a conversation: a fresh one when no token is given, the
   * one the token names when it can still be found, and a fresh one otherwise —
   * which the returned `restored` flag reports honestly.
   */
  bind(request: BindRequest): Promise<Binding>

  /**
   * Session reset: detach this session's conversation and bind a fresh stock
   * one to the same session (A12, A25). The detached conversation stays in
   * adapter-managed history, findable through `searchHistory`.
   */
  reset(sessionId: SessionId): Promise<Binding>

  /** Bind a session to a conversation found through `searchHistory` (A23). */
  resume(request: ResumeRequest): Promise<Binding>

  /** The settled items of a bound session's conversation, oldest first. */
  transcript(sessionId: SessionId): Promise<readonly TranscriptItem[]>

  /**
   * Forget everything held for this session in memory. Adapter-managed
   * persistence is never deleted: a removed session's conversation can be
   * resumed again later (A24).
   */
  release(sessionId: SessionId): void

  /** Search this adapter's own managed history for a workspace (A23). */
  searchHistory(workspacePath: string, query: string): Promise<readonly HistoryMatch[]>

  /**
   * Whether a binding token and a history ref name the same conversation. Both
   * are this adapter's own opaque strings, so this comparison is the only place
   * they may be interpreted — it is what keeps resume from adding a duplicate
   * sidebar entry (RES-5) without main learning what either string means.
   */
  sameConversation(token: string, ref: string): boolean

  /** The models the user can genuinely reach, with their native levels (A14). */
  listModels(): Promise<readonly ModelInfo[]>
  setModel(sessionId: SessionId, model: ModelId): Promise<void>
  setThinkingLevel(sessionId: SessionId, level: ThinkingLevel): Promise<void>

  /**
   * Run one turn for a session under the id main minted for it. Resolves when
   * the turn is over; the turn's whole story is told through events, so a
   * caller that only relays events may ignore the promise. A rejection means
   * the turn could not be run at all, and the caller owes the turn a terminal
   * event.
   */
  prompt(sessionId: SessionId, turnId: TurnId, text: string): Promise<void>

  /** Stop this session's live turn, if it has one. Harmless otherwise (A3). */
  cancel(sessionId: SessionId): Promise<void>

  onEvent(listener: AdapterEventListener): Unsubscribe

  /**
   * Abandon all live work — the document that was watching is gone — and
   * release what stood behind it. Idempotent, and the adapter stays usable for
   * the next document.
   */
  dispose(): void
}
