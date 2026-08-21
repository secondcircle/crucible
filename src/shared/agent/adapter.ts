import type {
  AuthMethod,
  AuthNotice,
  AuthPromptKind,
  AuthPromptOption,
  BashRunShare,
  ChangeFact,
  HistoryMatch,
  ImageAttachment,
  ModelId,
  ModelInfo,
  ProviderState,
  QueuedKind,
  QueuedMessage,
  SessionId,
  SessionTree,
  SessionUsage,
  ThinkingLevel,
  TranscriptItem,
  TurnId,
  Unsubscribe
} from './port'

// Crucible's identities go down and π's never come up: where a conversation
// lives is an opaque token nothing above this seam interprets.

// What changed between the compared turns, as far as the observer genuinely
// knows. Every value is a fact or an admission of ignorance; none is a cause.
export interface CacheMissChanges {
  readonly model: ChangeFact
  readonly thinking: ChangeFact
  readonly jump: ChangeFact
  readonly compaction: ChangeFact
  readonly tools: ChangeFact
  readonly rolePrompt: ChangeFact
}

// One observed miss, carrying the facts only the observer holds. Main adds
// the identity (which session or run) and the retention in force.
export interface ObservedCacheMiss {
  readonly provider: string
  readonly model: string
  /** Absent when the observer does not know it. */
  readonly thinkingLevel?: ThinkingLevel
  readonly tokensRebilled: number
  readonly dollarsRebilled: number
  /** Since the previous request. */
  readonly gapMs: number
  readonly changed: CacheMissChanges
}

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

// Asked for by identity whether or not the session is bound, which is why an
// unbound one has to carry the opaque token a bind would have used.
export interface UsageRequest {
  readonly sessionId: SessionId
  readonly workspacePath: string
  /** Absent for a session that was never given a conversation. */
  readonly token?: string
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
  // The argument-streaming window, which is the whole of a long call's first
  // seconds: the model has committed to the call, and nothing runs yet.
  | {
      readonly type: 'tool_call_started'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      readonly callId: string
      readonly name: string
    }
  | {
      readonly type: 'tool_call_args'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      readonly callId: string
      /** Cumulative and monotonic, so a dropped frame self-heals. */
      readonly chars: number
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
  // π scheduled another attempt at the branch summary a jump is waiting on.
  // Session-scoped like `usage`: a jump is not a turn, so there is no turn id
  // to carry. Emitted only while a summarizing jump is in flight for that
  // session, so a compaction retry inside a turn is never mistaken for one.
  | {
      readonly type: 'summarize_retry'
      readonly sessionId: SessionId
      /** 1-based, of π's own budget. */
      readonly attempt: number
      readonly maxAttempts: number
      readonly delayMs: number
      /** Display-safe; the provider's own payload went to the run log. */
      readonly message: string
    }
  | { readonly type: 'turn_ended'; readonly sessionId: SessionId; readonly turnId: TurnId }
  | { readonly type: 'turn_cancelled'; readonly sessionId: SessionId; readonly turnId: TurnId }
  | {
      readonly type: 'turn_error'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      readonly message: string
    }
  // Per detected miss, on the message that paid for it. No identity beyond
  // the session and the turn: what the ledger line says about where it
  // happened is main's to add.
  | {
      readonly type: 'cache_miss'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      readonly miss: ObservedCacheMiss
    }
  | {
      readonly type: 'usage'
      readonly sessionId: SessionId
      readonly usedTokens: number
      readonly contextWindow: number
      /** The conversation's dollars so far; absent until genuinely known. */
      readonly cost?: number
      // The whole conversation's misses, reported at the same moments the
      // tokens are. Absent until genuinely known.
      readonly cacheMisses?: { readonly count: number; readonly dollars: number }
    }
  // A live login's questions and running commentary. Session-less, because
  // credentials belong to the machine rather than to any conversation.
  | {
      readonly type: 'auth_prompt'
      readonly promptId: string
      readonly kind: AuthPromptKind
      readonly message: string
      readonly placeholder?: string
      readonly options?: readonly AuthPromptOption[]
    }
  | { readonly type: 'auth_prompt_closed'; readonly promptId: string }
  | { readonly type: 'auth_notice'; readonly notice: AuthNotice }
  // The whole queue after any change, session-scoped like `usage`: main folds
  // it into the snapshot rather than correlating it with a turn.
  | {
      readonly type: 'queue_changed'
      readonly sessionId: SessionId
      readonly steering: readonly string[]
      readonly followUp: readonly string[]
    }
  | {
      readonly type: 'user_message'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      readonly text: string
    }
  | {
      readonly type: 'queue_flushed'
      readonly sessionId: SessionId
      readonly messages: readonly QueuedMessage[]
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

  /** The conversation's full branching history, current position included. */
  sessionTree(sessionId: SessionId): Promise<SessionTree>
  // Moves the conversation to the moment before `ref` was sent, in place: the
  // abandoned path stays in the tree and stays reachable. A rejection means
  // the jump failed and the leaf did not move; a cancelled summary resolves
  // saying so, because the user asked for it.
  jump(
    sessionId: SessionId,
    ref: string,
    summarize: boolean
  ): Promise<{ readonly cancelled: boolean; readonly editorText?: string }>
  /** Persisted with the conversation; an absent or empty label clears it. */
  setLabel(sessionId: SessionId, ref: string, label?: string): Promise<void>

  // Both strings are this adapter's own, so this is the only place either may
  // be interpreted.
  sameConversation(token: string, ref: string): boolean

  /** The models the user can genuinely reach, with their native levels. */
  listModels(): Promise<readonly ModelInfo[]>
  // Answers with the level in effect after the switch, because the new model
  // may not support the level the old one was on.
  setModel(
    sessionId: SessionId,
    model: ModelId
  ): Promise<{ readonly thinkingLevel?: ThinkingLevel }>
  setThinkingLevel(sessionId: SessionId, level: ThinkingLevel): Promise<void>

  // Undefined when there is nothing to title, which is not a failure; a
  // failure rejects.
  titleConversation(sessionId: SessionId): Promise<
    | {
        readonly title: string
        readonly spend?: { readonly tokens: number; readonly cost: number }
      }
    | undefined
  >

  // Credentials are the agent side's, so they live behind this seam with the
  // models they unlock.
  listProviders(): Promise<readonly ProviderState[]>
  login(providerId: string, method: AuthMethod): Promise<void>
  answerAuthPrompt(promptId: string, value: string): Promise<void>
  cancelLogin(): Promise<void>
  logout(providerId: string): Promise<void>

  // Summed over the whole conversation, every branch of it. `undefined` means
  // nothing usage-bearing has been recorded yet.
  sessionUsage(request: UsageRequest): Promise<SessionUsage | undefined>

  // A rejection means the turn never ran, and the caller then owes it a
  // terminal event.
  prompt(
    sessionId: SessionId,
    turnId: TurnId,
    text: string,
    images?: readonly ImageAttachment[]
  ): Promise<void>

  // `'idle'` closes the same race `steer` does, and the caller then begins a
  // turn with `promptBashRun`; `'dropped'` means the live run was stopped first.
  shareBashRun(
    sessionId: SessionId,
    run: BashRunShare
  ): Promise<'delivered' | 'dropped' | 'idle'>

  // The idle path: a turn whose content is the run itself. The caller
  // announces it as `bash_run_shared`, never as a user message.
  promptBashRun(sessionId: SessionId, turnId: TurnId, run: BashRunShare): Promise<void>

  // `'idle'` closes the race between the caller's view of `working` and the
  // adapter's: nothing was queued, so the caller sends the text as a prompt.
  steer(sessionId: SessionId, text: string): Promise<'queued' | 'idle'>
  followUp(sessionId: SessionId, text: string): Promise<'queued' | 'idle'>
  /** Removes the first entry of that kind whose text matches. */
  dequeue(sessionId: SessionId, kind: QueuedKind, text: string): Promise<boolean>

  // Stops what the session is doing: its live turn, and the branch summary a
  // summarizing jump is waiting on. Harmless when there is neither.
  cancel(sessionId: SessionId): Promise<void>

  onEvent(listener: AdapterEventListener): Unsubscribe

  // Abandons live work but stays usable, because the next document will bind
  // to the same adapter.
  dispose(): void
}
