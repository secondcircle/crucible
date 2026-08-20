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
}

// π's two kinds, adopted verbatim: steering redirects the live turn at the
// next boundary between tool calls, a follow-up waits until the agent stops.
export type QueuedKind = 'steering' | 'followUp'

export interface QueuedMessage {
  readonly kind: QueuedKind
  readonly text: string
}

export interface QueueState {
  /** Undelivered steering messages, oldest first. */
  readonly steering: readonly string[]
  /** Undelivered follow-up messages, oldest first. */
  readonly followUp: readonly string[]
}

export type TabId = string

export type ExhibitKind = 'html' | 'markdown'

export interface PanelTab {
  readonly id: TabId
  readonly title: string
  readonly kind: ExhibitKind
  /** ISO of the latest show; a change means the body should be re-fetched. */
  readonly shownAt: string
}

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
  /** ISO; the neutral placeholder label derives from it. */
  readonly createdAt: string
  /** Present only for a worktree session; absent means the checkout. */
  readonly worktree?: SessionWorktree
  // True until the conversation's first message, and restored by a session
  // reset. The one condition under which the worktree may still be changed.
  readonly fresh: boolean
  // Absent until genuinely known, so nothing downstream shows a guess.
  readonly model?: ModelId
  readonly thinkingLevel?: ThinkingLevel
  readonly working: boolean
  // Absent until the adapter has reported real usage. `cost` is the whole
  // conversation's dollars so far and is absent until that too is known.
  readonly usage?: {
    readonly usedTokens: number
    readonly contextWindow: number
    readonly cost?: number
  }
  /** Absent when nothing is queued. */
  readonly queue?: QueueState
  // The context panel's tabs, folded in exactly as the queue is. Absent when
  // the session has no tabs, which is what makes the region vanish.
  readonly panel?: PanelState
}

export interface ShellSnapshot {
  readonly workspaces: readonly WorkspaceState[]
  readonly activeWorkspaceId?: WorkspaceId
  /** Curated entries only: adapter history never appears here. */
  readonly sessions: readonly SessionState[]
  readonly activeSessionId?: SessionId
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

  createSession(workspaceId: WorkspaceId): Promise<SessionId>
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
  jump(
    id: SessionId,
    ref: string,
    options: { readonly summarize: boolean }
  ): Promise<{ readonly editorText?: string }>
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
    images?: readonly ImageAttachment[]
  ): Promise<TurnId>

  // `'dropped'` means the live turn stopped before the run reached the
  // conversation: nothing fires at a plan the user killed.
  shareBashRun(sessionId: SessionId, run: BashRunShare): Promise<'delivered' | 'dropped'>

  // Never lost and never refused: with no live turn to take it, the message is
  // sent as the next prompt. Nothing enters the transcript at queue time.
  steer(sessionId: SessionId, text: string): Promise<void>
  followUp(sessionId: SessionId, text: string): Promise<void>
  /** By content, because delivery may have shifted any index. */
  dequeue(sessionId: SessionId, kind: QueuedKind, text: string): Promise<boolean>

  /** User clicked a tab. Unknown ids are a harmless no-op. */
  activateTab(sessionId: SessionId, tabId: TabId): Promise<void>
  /** User closed a tab. Unknown ids are a harmless no-op. */
  closeTab(sessionId: SessionId, tabId: TabId): Promise<void>
  // The exhibit's body, read at call time. The tab's path never crosses: the
  // renderer knows a tab by its id and by nothing else.
  exhibit(sessionId: SessionId, tabId: TabId): Promise<{ readonly body: string }>

  /** Harmless when there is nothing to stop. */
  cancel(sessionId: SessionId): Promise<void>
}
