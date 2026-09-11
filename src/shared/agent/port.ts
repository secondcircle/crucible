// This module imports nothing on purpose: it is the one module the renderer
// shares with main, so any import here could smuggle a π SDK type across.

export type WorkspaceId = string

// Survives a session reset: the conversation behind it is replaced, the id is
// not.
export type SessionId = string

export type TurnId = string

// Opaque to the renderer, which never parses it.
export type ModelId = string

// Whatever levels the adapter reports for a model; Crucible hard-codes none of
// its own.
export type ThinkingLevel = string

export interface ModelInfo {
  readonly id: ModelId
  readonly label: string
  readonly thinkingLevels: readonly ThinkingLevel[]
}

export interface WorkspaceState {
  readonly id: WorkspaceId
  readonly name: string
  /** An OS fact, never a π storage fact. */
  readonly path: string
  // ISO of the last moment something was used in one of this workspace's
  // sessions. Absent means nothing ever has been, which is what puts a
  // workspace at the bottom of the sidebar's list. A fact about the workspace
  // and not a roll-up of its sessions: forgetting a session does not unwind
  // what happened in it.
  readonly lastUsedAt?: string
}

// π's two kinds, adopted verbatim: steering redirects the live turn at the
// next boundary between tool calls, a follow-up waits until the agent stops.
export type QueuedKind = 'steering' | 'followUp'

// Who put a message in: a person, or Crucible itself carrying a run's voice.
// A fact about turns rather than about runs — the shell learns nothing else
// about what the text is — and what decides whether a turn is the user's.
export type MessageOrigin = 'user' | 'system'

// What the transcript shows for a message Crucible delivered on its own
// behalf. Presentation, not facts: the badge word, the tone as a color role, a
// title, a meta line and an optional body. The transcript learns nothing about
// what produced it, and a run's report can wear one later.
export interface SystemCard {
  readonly badge: string
  /** The color role the surface paints it in. */
  readonly tone: 'monitor' | 'warn' | 'bad'
  readonly title: string
  readonly meta: string
  readonly body?: string
}

// A message Crucible delivers to an agent: what the model reads, and what the
// person sees at the moment it lands. No card means it renders as today.
export interface SystemMessage {
  readonly text: string
  readonly card?: SystemCard
}

// One undelivered message and whatever rides with it. `images` is present only
// for images genuinely attached to it.
export interface QueuedEntry {
  readonly text: string
  readonly images?: readonly ImageAttachment[]
  /** Absent means a person queued it. Crucible's own cannot be dequeued. */
  readonly origin?: MessageOrigin
}

export interface QueuedMessage extends QueuedEntry {
  readonly kind: QueuedKind
}

export interface QueueState {
  /** Undelivered steering messages, oldest first. */
  readonly steering: readonly QueuedEntry[]
  /** Undelivered follow-up messages, oldest first. */
  readonly followUp: readonly QueuedEntry[]
}

export type TabId = string

export type ExhibitKind = 'html' | 'markdown' | 'url'

interface PanelTabBase {
  readonly id: TabId
  readonly title: string
  /** ISO of the latest show; a change means the body should be re-fetched. */
  readonly shownAt: string
}

// One field says where the exhibit is, and its shape follows the kind. Main
// resolved it at show time, against the session's own working directory, so a
// worktree session's tab names the worktree's file; the renderer displays it,
// copies it, and builds the `file:` URL a guest loads from it, resolving
// nothing itself.
export type PanelTab =
  | (PanelTabBase & {
      readonly kind: 'html'
      readonly path: string
    })
  | (PanelTabBase & {
      readonly kind: 'markdown'
      readonly path: string
    })
  | (PanelTabBase & {
      readonly kind: 'url'
      /** The full http(s) address, scheme included. */
      readonly address: string
    })

export interface PanelState {
  /** Show order, oldest first. Never empty: an empty panel is an absent one. */
  readonly tabs: readonly PanelTab[]
  readonly activeTabId: TabId
}

// Where a session works when it is not in its workspace's checkout. Crucible
// creates worktrees and never deletes them.
export interface SessionWorktree {
  /** Absolute, and the directory this session's work happens in. */
  readonly path: string
  /** Absent when the branch could not be read. */
  readonly branch?: string
}

export interface SessionState {
  readonly id: SessionId
  readonly workspaceId: WorkspaceId
  /** ISO; what the sidebar's relative time falls back to. */
  readonly createdAt: string
  // Absent until the first title lands, which is what the sidebar's untitled
  // state means.
  readonly title?: string
  /** ISO of the session's last activity; absent means `createdAt` stands in. */
  readonly lastActivityAt?: string
  /** Present only for a worktree session; absent means the checkout. */
  readonly worktree?: SessionWorktree
  // The issue this session was started on, as `crucible#128`. Set once, at
  // creation, by the issue board's Align; absent on every other session.
  readonly issue?: string
  // True until the conversation's first message, and restored by a session
  // reset. The one condition under which the worktree may still be changed.
  readonly fresh: boolean
  // Absent until genuinely known, so nothing downstream shows a guess.
  readonly model?: ModelId
  readonly thinkingLevel?: ThinkingLevel
  readonly working: boolean
  // ISO of the moment the live turn began, and absent whenever `working` is
  // false. The sidebar counts up from it: while a turn runs, how long it has
  // been running is the only time worth showing.
  readonly workingSince?: string
  // Absent until the adapter has reported real usage. `cost` is the whole
  // conversation's dollars so far and is absent until that too is known.
  readonly usage?: {
    readonly usedTokens: number
    readonly contextWindow: number
    readonly cost?: number
  }
  // The whole conversation's misses, every branch of it, exactly as `usage`
  // counts money: neither vanishes on a jump. Absent until genuinely known.
  readonly cacheMisses?: { readonly count: number; readonly dollars: number }
  // What the provider is still holding for this conversation, reported at the
  // same moments the usage is. Absent when nothing is cached: a fresh
  // conversation, no billed request yet, or a provider that has never
  // reported cache activity.
  readonly cachedPrefix?: CachedPrefix
  /** Absent when nothing is queued. */
  readonly queue?: QueueState
  // The context panel's tabs, folded in exactly as the queue is. Absent when
  // the session has no tabs, which is what makes the region vanish.
  readonly panel?: PanelState
}

// What Crucible knows about one fact of a cache miss. `'unknown'` is never
// guessed into an answer: a surface says nothing at all about an unknown.
export type ChangeFact = 'yes' | 'no' | 'unknown'

/** π's prompt retention: five minutes by default, an hour with PI_CACHE_RETENTION=long. */
export type CacheRetention = '5m' | '1h'

/** Who settled the retention in force: Crucible's own default, or the env var. */
export type RetentionSource = 'crucible' | 'env'

// The prefix a conversation has cached, and what sending against an expired
// one re-bills. What the cache expiry choice states, and the only fact its
// trigger reads.
export interface CachedPrefix {
  /** ISO of the conversation's last billed request. */
  readonly at: string
  /** Prompt tokens that request paid for — what an expired send re-bills. */
  readonly tokens: number
  /** Estimated dollars to re-bill them. An estimate, never a promise. */
  readonly rebillDollars: number
  /** The retention governing how long the provider keeps this prefix. */
  readonly retention: CacheRetention
}

// One miss as every surface shows it: facts, never a cause. Crucible records
// what it observed and names no culprit.
export interface CacheMissFacts {
  readonly tokensRebilled: number
  readonly dollarsRebilled: number
  /** Since the previous request, which is what an idle expiry looks like. */
  readonly gapMs: number
  readonly modelChanged: ChangeFact
  readonly thinkingChanged: ChangeFact
  /** Whether a jump intervened between the compared turns. */
  readonly jump: ChangeFact
  readonly retention: CacheRetention
}

export interface ShellSnapshot {
  readonly workspaces: readonly WorkspaceState[]
  readonly activeWorkspaceId?: WorkspaceId
  /** Curated entries only: adapter history never appears here. */
  readonly sessions: readonly SessionState[]
  readonly activeSessionId?: SessionId
}

// What the sender already knew when the prompt left. The cache expiry choice
// is the one surface that tells a person, before the send, that this turn will
// re-bill the conversation; "send anyway" carries that here so the miss it
// causes is written down as one the person chose rather than one that caught
// them.
export interface PromptOptions {
  readonly expiryAcknowledged?: boolean
}

// What a person attached to a message: bytes, never a path, so nothing about
// where the file sat on disk crosses.
export interface ImageAttachment {
  /** One of image/png, image/jpeg, image/gif, image/webp. */
  readonly mimeType: string
  /** Base64, no `data:` prefix. The original file is no larger than 10 MiB. */
  readonly data: string
}

export interface TreeNode {
  // Adapter-minted and opaque, like `HistoryMatch.ref`: no π storage concept
  // crosses.
  readonly ref: string
  /** The user message, verbatim. */
  readonly text: string
  /** ISO time the message entered the conversation. */
  readonly at: string
  readonly label?: string
  // Derived from the real entries, e.g. "assistant · 2 edit · 1 bash", and
  // absent when nothing followed this message yet.
  readonly activity?: string
  /** Creation order. More than one child is a branch point. */
  readonly children: readonly TreeNode[]
}

export interface SessionTree {
  readonly roots: readonly TreeNode[]
  /** Refs from root to the current position, oldest first. Empty when fresh. */
  readonly path: readonly string[]
}

export interface BashRunShare {
  readonly command: string
  /** stdout and stderr interleaved, as streamed. */
  readonly output: string
  /** Absent when the run was stopped before exiting. */
  readonly exitCode?: number
}

// Restored history and live stream items share this shape so both render
// through the same code.
export type TranscriptItem =
  | {
      readonly kind: 'user'
      readonly text: string
      /** Present only for images that were genuinely sent with the message. */
      readonly images?: readonly ImageAttachment[]
    }
  | { readonly kind: 'assistant'; readonly markdown: string }
  | { readonly kind: 'thinking'; readonly text: string; readonly seconds?: number }
  | {
      readonly kind: 'tool'
      readonly name: string
      readonly summary: string
      readonly ok: boolean
      readonly output: string
    }
  // A bash run the user added to the conversation: local runs never appear
  // here at all.
  | {
      readonly kind: 'bashRun'
      readonly command: string
      readonly output: string
      readonly exitCode?: number
    }
  // The context a jump-with-summary or a compaction carried forward: what
  // the conversation is standing on now, shown so nobody starts blind.
  | { readonly kind: 'summary'; readonly text: string }
  // The seam, immediately above the assistant message that paid for it, so a
  // reopened conversation shows its misses where they happened.
  | { readonly kind: 'cacheMiss'; readonly miss: CacheMissFacts }
  /** The quiet marker that closes a cancelled turn. */
  | { readonly kind: 'stopped' }
  | { readonly kind: 'error'; readonly message: string }

export interface HistoryMatch {
  // Adapter-minted and opaque: no path, no filename, no storage concept
  // crosses the port.
  readonly ref: string
  readonly preview: string
  /** ISO time of the conversation's last activity. */
  readonly at: string
}

// π's per-message numbers, summed by Crucible: π keeps no ledger of its own.
export interface UsageLine {
  readonly tokens: number
  readonly cost: number
}

export interface SessionUsage {
  /** How many usage-bearing messages were summed. */
  readonly messages: number
  readonly input: UsageLine
  readonly output: UsageLine
  readonly cacheRead: UsageLine
  readonly cacheWrite: UsageLine
  readonly totalTokens: number
  readonly totalCost: number
}

/** The two ways a login may be carried out; π's `AuthType`, in Crucible's words. */
export type AuthMethod = 'oauth' | 'api-key'

export interface ProviderState {
  readonly id: string
  readonly name: string
  /** Methods a login may use; empty means not loggable from Crucible. */
  readonly methods: readonly AuthMethod[]
  readonly status:
    | { readonly kind: 'none' }
    | { readonly kind: 'oauth'; readonly detail?: string }
    | { readonly kind: 'api-key' }
    // Managed outside Crucible: shown, never edited.
    | { readonly kind: 'env'; readonly variable?: string }
}

export type AuthPromptKind = 'text' | 'secret' | 'select' | 'manual-code'

export interface AuthPromptOption {
  readonly id: string
  readonly label: string
  readonly description?: string
}

// Everything a live login flow says that is not a question. π's `AuthEvent`,
// rewritten in Crucible's own words so no SDK type crosses.
export type AuthNotice =
  | { readonly kind: 'info'; readonly message: string }
  | { readonly kind: 'progress'; readonly message: string }
  | { readonly kind: 'auth-url'; readonly message: string; readonly url: string }
  | {
      readonly kind: 'device-code'
      readonly message: string
      readonly userCode: string
      readonly verificationUri: string
    }

export type PortEvent =
  | { readonly type: 'state'; readonly snapshot: ShellSnapshot }
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
  // The model committed to a call and is streaming its arguments: the element
  // exists from this moment, seconds before the call begins running.
  | {
      readonly type: 'tool_call_started'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      readonly callId: string
      readonly name: string
    }
  // How many argument characters have streamed so far, cumulative and
  // monotonic, so a dropped frame self-heals on the next one.
  | {
      readonly type: 'tool_call_args'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      readonly callId: string
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
  // Only for a message the port delivered itself. Text sent through `prompt()`
  // is never announced this way, because its caller echoes its own.
  | {
      readonly type: 'user_message'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      readonly text: string
      /** Present only for images the delivered message genuinely carried. */
      readonly images?: readonly ImageAttachment[]
      // Present only when the shell delivered a system message carrying one:
      // what the person sees instead of a user's bubble.
      readonly card?: SystemCard
    }
  // Announced at the moment a shared bash run genuinely enters the
  // conversation, which is its delivery point and never before it.
  | {
      readonly type: 'bash_run_shared'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      readonly command: string
      readonly output: string
      readonly exitCode?: number
    }
  // Queued messages handed back rather than delivered, steering first. Nothing
  // flushed is delivered afterwards.
  | {
      readonly type: 'queue_flushed'
      readonly sessionId: SessionId
      readonly messages: readonly QueuedMessage[]
    }
  // Follows the `state` event carrying the show, so a listener already holds
  // the snapshot this names. A user's own switch or close says nothing.
  | { readonly type: 'panel_shown'; readonly sessionId: SessionId; readonly tabId: TabId }
  // One completed assistant message re-billed prompt tokens the previous turn
  // had already paid to cache. Announced per miss; a turn may pay for more
  // than one.
  | {
      readonly type: 'cache_miss'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      readonly miss: CacheMissFacts
    }
  // π scheduled another attempt at a branch summary a jump is waiting on.
  // Session-scoped like `usage`, with no turn id, because a jump is not a
  // turn.
  | {
      readonly type: 'summarize_retry'
      readonly sessionId: SessionId
      /** 1-based, of π's own budget; Crucible adds no retries of its own. */
      readonly attempt: number
      readonly maxAttempts: number
      readonly delayMs: number
      /** Display-safe provider text; the detail went to the run log. */
      readonly message: string
    }
  | { readonly type: 'turn_ended'; readonly sessionId: SessionId; readonly turnId: TurnId }
  | { readonly type: 'turn_cancelled'; readonly sessionId: SessionId; readonly turnId: TurnId }
  | {
      readonly type: 'turn_error'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      /** Display-safe; the detail went to the run log. */
      readonly message: string
    }
  // A login flow's question, answered with `answerAuthPrompt`. Not tied to any
  // session: credentials are global.
  | {
      readonly type: 'auth_prompt'
      readonly promptId: string
      readonly kind: AuthPromptKind
      readonly message: string
      readonly placeholder?: string
      /** Present for `select`; the answer is an option's id. */
      readonly options?: readonly AuthPromptOption[]
    }
  // The flow resolved that question out of band — the browser callback won the
  // race against the paste field — so the input goes away unanswered.
  | { readonly type: 'auth_prompt_closed'; readonly promptId: string }
  | { readonly type: 'auth_notice'; readonly notice: AuthNotice }

export type PortEventListener = (event: PortEvent) => void

export type Unsubscribe = () => void

export interface AgentPort {
  snapshot(): Promise<ShellSnapshot>
  /** Live-only: no replay, no backlog. */
  onEvent(listener: PortEventListener): Unsubscribe

  /** `null` means the user cancelled the picker. */
  addWorkspace(): Promise<WorkspaceId | null>
  activateWorkspace(id: WorkspaceId): Promise<void>
  /** Forgets the workspace in Crucible; the OS folder is untouched. */
  removeWorkspace(id: WorkspaceId): Promise<void>

  // `issue` records what the session was started on and nothing more: it is
  // what lets the issue board say an issue is already picked up.
  createSession(
    workspaceId: WorkspaceId,
    options?: { readonly issue?: string }
  ): Promise<SessionId>
  activateSession(id: SessionId): Promise<void>
  /** Forgets the sidebar entry only; adapter persistence stays. */
  removeSession(id: SessionId): Promise<void>
  /** Keeps the identity, binds a fresh stock conversation to it. */
  resetSession(id: SessionId): Promise<void>
  transcript(id: SessionId): Promise<readonly TranscriptItem[]>

  searchHistory(workspaceId: WorkspaceId, query: string): Promise<readonly HistoryMatch[]>
  /** Adds the conversation to the curated sidebar and activates it. */
  resumeSession(workspaceId: WorkspaceId, ref: string): Promise<SessionId>

  /** The session's full branching history. Allowed while the session works. */
  sessionTree(id: SessionId): Promise<SessionTree>
  // A jump: continue in place from the moment before `ref` was sent. Refused
  // while the session works. `editorText` comes back to the composer unsent.
  //
  // A rejection means one thing only: the jump failed and the leaf did not
  // move. A user's cancellation is not a failure, so it resolves saying so.
  jump(
    id: SessionId,
    ref: string,
    options: { readonly summarize: boolean }
  ): Promise<{
    /** True: the user cancelled it, and the leaf did not move. */
    readonly cancelled: boolean
    /** Present only on a real jump. */
    readonly editorText?: string
  }>
  /** Free-text label on a node; absent or empty clears it. Allowed anytime. */
  setLabel(id: SessionId, ref: string, label?: string): Promise<void>

  // Attaches a worktree to a session, or with none puts it back on the
  // checkout. Refused unless the session is fresh; nothing on disk is deleted
  // either way.
  setWorktree(sessionId: SessionId, worktree?: SessionWorktree): Promise<void>

  listModels(): Promise<readonly ModelInfo[]>
  setModel(sessionId: SessionId, model: ModelId): Promise<void>
  setThinkingLevel(sessionId: SessionId, level: ThinkingLevel): Promise<void>

  /** Every provider the agent side knows, credentialed or not, in its order. */
  listProviders(): Promise<readonly ProviderState[]>
  // Resolves on success, rejects display-safely on failure or cancel. The
  // flow's questions arrive as `auth_prompt` events while it runs.
  login(providerId: string, method: AuthMethod): Promise<void>
  answerAuthPrompt(promptId: string, value: string): Promise<void>
  /** Aborts the live flow. Harmless when no login is running. */
  cancelLogin(): Promise<void>
  logout(providerId: string): Promise<void>

  // Every branch of the conversation, because money spent does not vanish on
  // a jump. Absent until the adapter has genuinely reported usage.
  sessionUsage(id: SessionId): Promise<SessionUsage | undefined>

  // Accepted, not finished: resolves once the turn is live. Images ride the
  // prompt they were attached to and nothing else.
  prompt(
    sessionId: SessionId,
    text: string,
    images?: readonly ImageAttachment[],
    options?: PromptOptions
  ): Promise<TurnId>

  // `'dropped'` means the live turn stopped before the run reached the
  // conversation: nothing fires at a plan the user killed.
  shareBashRun(sessionId: SessionId, run: BashRunShare): Promise<'delivered' | 'dropped'>

  // Never lost and never refused: with no live turn to take it, the message is
  // sent as the next prompt. Nothing enters the transcript at queue time.
  // Images ride a queued message exactly as they ride a prompt.
  steer(sessionId: SessionId, text: string, images?: readonly ImageAttachment[]): Promise<void>
  // A person's follow-up, always: Crucible's own messages take `deliver` on
  // the shell instead, which is the one road every message it sends itself
  // travels.
  followUp(
    sessionId: SessionId,
    text: string,
    images?: readonly ImageAttachment[]
  ): Promise<void>
  // Named by content, because delivery may have shifted any index; answered
  // with the entry that left, because two queued messages can read alike.
  dequeue(
    sessionId: SessionId,
    kind: QueuedKind,
    text: string
  ): Promise<QueuedEntry | undefined>

  /** User clicked a tab. Unknown ids are a harmless no-op. */
  activateTab(sessionId: SessionId, tabId: TabId): Promise<void>
  /** User closed a tab. Unknown ids are a harmless no-op. */
  closeTab(sessionId: SessionId, tabId: TabId): Promise<void>
  // The exhibit's body, read at call time. Asked for by tab id alone: the
  // location a tab carries is what the panel displays, never what it reads by.
  exhibit(sessionId: SessionId, tabId: TabId): Promise<{ readonly body: string }>

  // Stop what this session is doing: the live turn, and a summarizing jump
  // waiting on π's summary. Harmless when there is nothing to stop.
  cancel(sessionId: SessionId): Promise<void>
}
