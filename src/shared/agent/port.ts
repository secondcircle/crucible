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
  /** Harmless when there is nothing to stop. */
  cancel(sessionId: SessionId): Promise<void>
}
