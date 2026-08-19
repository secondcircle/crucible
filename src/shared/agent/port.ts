/**
 * The agent port: the Crucible-owned interface between the UI layer and
 * everything agent-side (ADR 0001).
 *
 * This module imports nothing, on purpose. It is the one module the renderer
 * shares with the main process, so an import added here is the single edit that
 * could smuggle a π SDK type across the seam — the line to watch in review.
 *
 * The port is wide enough for the whole shell: workspaces, curated sessions,
 * models, thinking levels, transcripts, prompts and cancellation. Everything
 * behind it — which adapter answered, whether a process boundary was crossed,
 * what a conversation is stored as — stays behind it.
 *
 * Contract rules a caller may rely on, all of them enforced in main:
 *
 * - **Turn ordering, per session.** Every accepted prompt produces exactly one
 *   `turn_started`, then any interleaving of `text_delta`, `thinking_delta` and
 *   tool events, then exactly one terminal event — `turn_ended`,
 *   `turn_cancelled` or `turn_error`. Nothing more is emitted for a turn after
 *   its terminal event. Each `callId` sees one `tool_started`, zero or more
 *   `tool_output`, one `tool_ended`, all inside its turn. Events for different
 *   sessions interleave freely.
 * - **`state` events carry the whole snapshot**, so a late one always
 *   supersedes an earlier one and nothing has to be merged by a consumer.
 * - **Subscribe first, then snapshot, then prompt.** Subscription is live-only:
 *   no replay, no backlog. Events may arrive before the promise of the
 *   operation that caused them resolves.
 * - **Cancelled is its own outcome.** It is neither an error nor a normal end,
 *   and the three are distinguishable by every consumer.
 * - **Cancellation is targeted.** `cancel(sessionId)` affects at most the live
 *   turn of that session at the moment it is handled. With no live turn it does
 *   nothing, and a cancel that loses the race with a turn's natural end can
 *   never touch a later turn.
 * - **Refusals reject.** A `prompt` to a session that already has a live turn,
 *   or to a session that does not exist, rejects with a display-safe message
 *   and mints no turn.
 * - **One live turn per session, many per app** (ADR 0003).
 * - **Errors are display-safe.** Stacks, SDK objects and provider payloads go
 *   to the run log only.
 * - **Every event is a plain structured-clone-safe object.**
 */

/** A workspace: an OS folder opened in Crucible. Crucible-minted, opaque. */
export type WorkspaceId = string

/**
 * A session: the sidebar identity of one agent conversation. Crucible-minted
 * and opaque (ADR 0004). It survives Session reset — the conversation behind it
 * is replaced, the id is not — and it is what every per-session operation and
 * event carries.
 */
export type SessionId = string

/** One turn: one prompt and everything streamed back for it. */
export type TurnId = string

/** A model, as the port names it. Opaque to the renderer: never parsed there. */
export type ModelId = string

/**
 * A native π thinking level, as the adapter reports it for a model — `off`,
 * `low`, `medium`, … . Crucible hard-codes no level of its own (A22).
 */
export type ThinkingLevel = string

/** A model the user can genuinely reach, with the levels it natively supports. */
export interface ModelInfo {
  readonly id: ModelId
  readonly label: string
  /** This model's native thinking levels, in the order the adapter reports. */
  readonly thinkingLevels: readonly ThinkingLevel[]
}

/** A workspace, as the shell shows it. */
export interface WorkspaceState {
  readonly id: WorkspaceId
  /** The folder's basename — what the sidebar row and the top bar show. */
  readonly name: string
  /** The OS folder. An OS fact, never a π storage fact. */
  readonly path: string
}

/** A curated session, as the shell shows it. */
export interface SessionState {
  readonly id: SessionId
  readonly workspaceId: WorkspaceId
  /** ISO; the neutral placeholder label derives from it (A26). */
  readonly createdAt: string
  /** Absent until genuinely known — never a guess (A27). */
  readonly model?: ModelId
  readonly thinkingLevel?: ThinkingLevel
  /** True while a live turn exists for this session. */
  readonly working: boolean
  /** Absent until the adapter has reported real usage (TB-2). */
  readonly usage?: { readonly usedTokens: number; readonly contextWindow: number }
}

/** Everything the shell knows about itself, in one value. */
export interface ShellSnapshot {
  readonly workspaces: readonly WorkspaceState[]
  readonly activeWorkspaceId?: WorkspaceId
  /** Curated entries only: adapter history never appears here (ADR 0002). */
  readonly sessions: readonly SessionState[]
  readonly activeSessionId?: SessionId
}

/**
 * One settled item of a conversation. This is what a restored transcript is
 * made of, and what the renderer's live items are shaped like, so history and
 * a stream render through the same code (TR-7).
 */
export type TranscriptItem =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'assistant'; readonly markdown: string }
  | { readonly kind: 'thinking'; readonly text: string; readonly seconds?: number }
  | {
      readonly kind: 'tool'
      readonly name: string
      readonly summary: string
      readonly ok: boolean
      readonly output: string
    }
  /** The quiet marker that closes a cancelled turn (A4). */
  | { readonly kind: 'stopped' }
  | { readonly kind: 'error'; readonly message: string }

/**
 * One hit of a history search. `ref` is adapter-minted and opaque: no path, no
 * filename, no storage concept crosses the port (ADR 0004, A28).
 */
export interface HistoryMatch {
  readonly ref: string
  /** A display-safe scent of the conversation. */
  readonly preview: string
  /** ISO time of the conversation's last activity. */
  readonly at: string
}

/** Everything the port says, and all it says. */
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
  | { readonly type: 'turn_ended'; readonly sessionId: SessionId; readonly turnId: TurnId }
  | { readonly type: 'turn_cancelled'; readonly sessionId: SessionId; readonly turnId: TurnId }
  | {
      readonly type: 'turn_error'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      /** Display-safe; the detail went to the run log. */
      readonly message: string
    }

/** What a subscriber is handed each event, in the order the port emits them. */
export type PortEventListener = (event: PortEvent) => void

/** Ends a subscription. Calling it more than once is allowed and does nothing. */
export type Unsubscribe = () => void

/**
 * The seam itself. Three implementations satisfy it — main's shell, the IPC
 * client in the renderer, and a scripted one in a component test — so what a
 * caller may rely on is stated here rather than per implementation.
 */
export interface AgentPort {
  /** The whole shell state, right now. */
  snapshot(): Promise<ShellSnapshot>
  /** Live-only subscription; returns its own unsubscribe. */
  onEvent(listener: PortEventListener): Unsubscribe

  /** Opens the OS folder picker. `null` means the user cancelled (WS-1). */
  addWorkspace(): Promise<WorkspaceId | null>
  activateWorkspace(id: WorkspaceId): Promise<void>
  /** Forgets the workspace in Crucible. The OS folder is untouched (WS-4). */
  removeWorkspace(id: WorkspaceId): Promise<void>

  createSession(workspaceId: WorkspaceId): Promise<SessionId>
  activateSession(id: SessionId): Promise<void>
  /** Forgets the sidebar entry only; adapter persistence stays (A24). */
  removeSession(id: SessionId): Promise<void>
  /** Keeps the identity, binds a fresh stock conversation to it (A12, A25). */
  resetSession(id: SessionId): Promise<void>
  /** Settled history for a session with no live turn this launch. */
  transcript(id: SessionId): Promise<readonly TranscriptItem[]>

  /** Adapter-managed history, searched only when asked (A23). */
  searchHistory(workspaceId: WorkspaceId, query: string): Promise<readonly HistoryMatch[]>
  /** Adds the conversation to the curated sidebar and activates it (A23). */
  resumeSession(workspaceId: WorkspaceId, ref: string): Promise<SessionId>

  listModels(): Promise<readonly ModelInfo[]>
  setModel(sessionId: SessionId, model: ModelId): Promise<void>
  setThinkingLevel(sessionId: SessionId, level: ThinkingLevel): Promise<void>

  /** Accepted, not finished: resolves with the turn's id once it is live. */
  prompt(sessionId: SessionId, text: string): Promise<TurnId>
  /** Immediate, session-local, and harmless when there is nothing to stop. */
  cancel(sessionId: SessionId): Promise<void>
}
