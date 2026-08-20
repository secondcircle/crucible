// This module imports nothing on purpose: it is the one module the renderer
// shares with main, so any import added here could smuggle a π SDK type across
// the seam.

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

// π's two kinds of queued message, adopted verbatim: a steering message
// redirects the live turn at the next boundary between tool calls, a follow-up
// waits until the agent has fully stopped.
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

export interface SessionState {
  readonly id: SessionId
  readonly workspaceId: WorkspaceId
  /** ISO; the neutral placeholder label derives from it. */
  readonly createdAt: string
  // Absent until genuinely known, so nothing downstream shows a guess.
  readonly model?: ModelId
  readonly thinkingLevel?: ThinkingLevel
  readonly working: boolean
  // Absent until the adapter has reported real usage.
  readonly usage?: { readonly usedTokens: number; readonly contextWindow: number }
  /** Absent when nothing is queued. */
  readonly queue?: QueueState
}

export interface ShellSnapshot {
  readonly workspaces: readonly WorkspaceState[]
  readonly activeWorkspaceId?: WorkspaceId
  /** Curated entries only: adapter history never appears here. */
  readonly sessions: readonly SessionState[]
  readonly activeSessionId?: SessionId
}

// Restored history and live stream items share this shape so both render
// through the same code.
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
  // A user message the port itself delivered into the conversation: a queued
  // message at its delivery point, or a steer that fell back to a prompt.
  // Text sent through `prompt()` is never announced this way, because the
  // caller of `prompt()` echoes its own.
  | {
      readonly type: 'user_message'
      readonly sessionId: SessionId
      readonly turnId: TurnId
      readonly text: string
    }
  // Queued messages handed back rather than delivered: on cancel and on turn
  // error. Queue order, steering first. Nothing flushed is delivered after.
  | {
      readonly type: 'queue_flushed'
      readonly sessionId: SessionId
      readonly messages: readonly QueuedMessage[]
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

  listModels(): Promise<readonly ModelInfo[]>
  setModel(sessionId: SessionId, model: ModelId): Promise<void>
  setThinkingLevel(sessionId: SessionId, level: ThinkingLevel): Promise<void>

  // Accepted, not finished: resolves once the turn is live.
  prompt(sessionId: SessionId, text: string): Promise<TurnId>

  // Neither of these is ever lost and neither is ever refused: the message is
  // queued and delivered within the live turn, or — when no turn is live, or
  // the live turn ends before it can be queued — sent as the next prompt.
  // Nothing enters the transcript at queue time.
  steer(sessionId: SessionId, text: string): Promise<void>
  followUp(sessionId: SessionId, text: string): Promise<void>
  // Names the entry by content rather than by an index delivery may have
  // shifted.
  /** True when the entry was removed; false when it was no longer queued. */
  dequeue(sessionId: SessionId, kind: QueuedKind, text: string): Promise<boolean>

  /** Harmless when there is nothing to stop. */
  cancel(sessionId: SessionId): Promise<void>
}
