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

// Crucible's identities go down and π's never come up: a session is named by
// its Crucible id, and where its conversation lives is an opaque token nothing
// above this seam interprets.

export interface Binding {
  /** Opaque; the store persists it, and only this adapter reads it. */
  readonly token: string
  /** The model actually in effect, after any fallback. */
  readonly model?: ModelId
  readonly thinkingLevel?: ThinkingLevel
  // False means a fresh conversation was bound instead, which is also why the
  // token may have changed.
  readonly restored: boolean
}

export interface BindRequest {
  readonly sessionId: SessionId
  /** The folder the agent works in. */
  readonly workspacePath: string
  /** A token from an earlier launch; absent means bind a fresh conversation. */
  readonly token?: string
  /** Honored only when the model is available. */
  readonly preferredModel?: ModelId
  readonly preferredThinkingLevel?: ThinkingLevel
}

export interface ResumeRequest {
  readonly sessionId: SessionId
  readonly workspacePath: string
  /** An opaque `ref` from `searchHistory`. */
  readonly ref: string
}

// The port's turn events minus `state`, which only main can produce, plus
// `usage`, which main folds into the snapshot.
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

export interface ConversationAdapter {
  bind(request: BindRequest): Promise<Binding>

  // The detached conversation is kept, not deleted: it stays findable through
  // `searchHistory`.
  reset(sessionId: SessionId): Promise<Binding>

  resume(request: ResumeRequest): Promise<Binding>

  /** Settled items only, oldest first. */
  transcript(sessionId: SessionId): Promise<readonly TranscriptItem[]>

  // In-memory only: persistence is never deleted, so a removed session's
  // conversation can be resumed later.
  release(sessionId: SessionId): void

  searchHistory(workspacePath: string, query: string): Promise<readonly HistoryMatch[]>

  // Both strings are this adapter's own, so this is the only place either may
  // be interpreted.
  sameConversation(token: string, ref: string): boolean

  /** The models the user can genuinely reach, with their native levels. */
  listModels(): Promise<readonly ModelInfo[]>
  setModel(sessionId: SessionId, model: ModelId): Promise<void>
  setThinkingLevel(sessionId: SessionId, level: ThinkingLevel): Promise<void>

  // The turn id comes from above so nothing has to be correlated afterwards.
  // A rejection means the turn never ran, and the caller then owes it a
  // terminal event.
  prompt(sessionId: SessionId, turnId: TurnId, text: string): Promise<void>

  /** Harmless when the session has no live turn. */
  cancel(sessionId: SessionId): Promise<void>

  onEvent(listener: AdapterEventListener): Unsubscribe

  // Abandons live work but stays usable, because the next document will bind
  // to the same adapter.
  dispose(): void
}
