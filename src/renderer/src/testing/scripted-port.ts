import type {
  AgentPort,
  HistoryMatch,
  ModelId,
  ModelInfo,
  PortEvent,
  PortEventListener,
  SessionId,
  SessionState,
  ShellSnapshot,
  ThinkingLevel,
  TranscriptItem,
  TurnId,
  WorkspaceId
} from '../../../shared/agent/port'

// Answers operations the way main does, but streams nothing by itself: a test
// says exactly what arrives and when, which keeps component tests about
// rendering rather than about timing.
export interface ScriptedPort extends AgentPort {
  readonly calls: ReadonlyArray<{ readonly op: string; readonly args: readonly unknown[] }>
  /** The snapshot as it stands, which every `state` event carries whole. */
  readonly snapshotNow: ShellSnapshot
  models: readonly ModelInfo[]
  history: readonly HistoryMatch[]
  readonly transcripts: Map<SessionId, readonly TranscriptItem[]>
  /** What the folder picker will answer with; `null` is a cancelled picker. */
  folder: string | null

  update(change: (snapshot: ShellSnapshot) => ShellSnapshot): void
  emit(event: PortEvent): void

  turnOf(sessionId: SessionId): TurnId | undefined
  text(sessionId: SessionId, delta: string): void
  thinking(sessionId: SessionId, delta: string): void
  toolStarted(sessionId: SessionId, callId: string, name: string, summary: string): void
  toolOutput(sessionId: SessionId, callId: string, chunk: string): void
  toolEnded(sessionId: SessionId, callId: string, ok: boolean, output: string): void
  endTurn(sessionId: SessionId): void
  failTurn(sessionId: SessionId, message: string): void
}

const NOW = '2026-08-19T14:14:00.000Z'

export function createScriptedPort(initial: Partial<ShellSnapshot> = {}): ScriptedPort {
  const listeners = new Set<PortEventListener>()
  const calls: Array<{ op: string; args: readonly unknown[] }> = []
  const turns = new Map<SessionId, TurnId>()
  let snapshot: ShellSnapshot = {
    workspaces: [],
    sessions: [],
    ...initial
  }
  let minted = 0

  function emit(event: PortEvent): void {
    for (const listener of [...listeners]) listener(event)
  }

  function emitState(): void {
    emit({ type: 'state', snapshot })
  }

  function record<T>(op: string, args: readonly unknown[], answer: T): Promise<T> {
    calls.push({ op, args })
    return Promise.resolve(answer)
  }

  function changeSession(id: SessionId, change: (session: SessionState) => SessionState): void {
    snapshot = {
      ...snapshot,
      sessions: snapshot.sessions.map((session) => (session.id === id ? change(session) : session))
    }
  }

  function turn(sessionId: SessionId): TurnId {
    const live = turns.get(sessionId)
    if (live === undefined) throw new Error(`no live turn for ${sessionId}`)
    return live
  }

  function finish(sessionId: SessionId, event: PortEvent): void {
    turns.delete(sessionId)
    changeSession(sessionId, (session) => ({ ...session, working: false }))
    emit(event)
    emitState()
  }

  const port: ScriptedPort = {
    calls,
    models: [],
    history: [],
    transcripts: new Map(),
    folder: null,

    get snapshotNow() {
      return snapshot
    },

    snapshot: () => record('snapshot', [], snapshot),

    onEvent(listener: PortEventListener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    addWorkspace(): Promise<WorkspaceId | null> {
      calls.push({ op: 'addWorkspace', args: [] })
      if (port.folder === null) return Promise.resolve(null)
      const id = `w-${(minted += 1)}`
      const name = port.folder.split('/').filter(Boolean).at(-1) ?? port.folder
      snapshot = {
        ...snapshot,
        workspaces: [...snapshot.workspaces, { id, name, path: port.folder }],
        activeWorkspaceId: id
      }
      emitState()
      return Promise.resolve(id)
    },

    activateWorkspace(id: WorkspaceId): Promise<void> {
      calls.push({ op: 'activateWorkspace', args: [id] })
      const own = snapshot.sessions.find((session) => session.workspaceId === id)
      snapshot = { ...snapshot, activeWorkspaceId: id, activeSessionId: own?.id }
      emitState()
      return Promise.resolve()
    },

    removeWorkspace(id: WorkspaceId): Promise<void> {
      calls.push({ op: 'removeWorkspace', args: [id] })
      snapshot = {
        ...snapshot,
        workspaces: snapshot.workspaces.filter((workspace) => workspace.id !== id),
        sessions: snapshot.sessions.filter((session) => session.workspaceId !== id),
        activeWorkspaceId: undefined,
        activeSessionId: undefined
      }
      emitState()
      return Promise.resolve()
    },

    createSession(workspaceId: WorkspaceId): Promise<SessionId> {
      calls.push({ op: 'createSession', args: [workspaceId] })
      const id = `s-${(minted += 1)}`
      snapshot = {
        ...snapshot,
        sessions: [
          ...snapshot.sessions,
          {
            id,
            workspaceId,
            createdAt: NOW,
            working: false,
            model: port.models[0]?.id,
            thinkingLevel: port.models[0]?.thinkingLevels[0]
          }
        ],
        activeSessionId: id
      }
      emitState()
      return Promise.resolve(id)
    },

    activateSession(id: SessionId): Promise<void> {
      calls.push({ op: 'activateSession', args: [id] })
      snapshot = { ...snapshot, activeSessionId: id }
      emitState()
      return Promise.resolve()
    },

    removeSession(id: SessionId): Promise<void> {
      calls.push({ op: 'removeSession', args: [id] })
      const sessions = snapshot.sessions.filter((session) => session.id !== id)
      snapshot = {
        ...snapshot,
        sessions,
        activeSessionId: snapshot.activeSessionId === id ? sessions[0]?.id : snapshot.activeSessionId
      }
      emitState()
      return Promise.resolve()
    },

    resetSession(id: SessionId): Promise<void> {
      calls.push({ op: 'resetSession', args: [id] })
      port.transcripts.set(id, [])
      changeSession(id, (session) => ({ ...session, usage: undefined }))
      emitState()
      return Promise.resolve()
    },

    transcript(id: SessionId): Promise<readonly TranscriptItem[]> {
      return record('transcript', [id], port.transcripts.get(id) ?? [])
    },

    searchHistory(workspaceId: WorkspaceId, query: string): Promise<readonly HistoryMatch[]> {
      const wanted = query.trim().toLowerCase()
      return record(
        'searchHistory',
        [workspaceId, query],
        port.history.filter(
          (match) => wanted === '' || match.preview.toLowerCase().includes(wanted)
        )
      )
    },

    resumeSession(workspaceId: WorkspaceId, ref: string): Promise<SessionId> {
      calls.push({ op: 'resumeSession', args: [workspaceId, ref] })
      const id = `s-${(minted += 1)}`
      snapshot = {
        ...snapshot,
        sessions: [
          ...snapshot.sessions,
          { id, workspaceId, createdAt: NOW, working: false, model: port.models[0]?.id }
        ],
        activeSessionId: id
      }
      emitState()
      return Promise.resolve(id)
    },

    listModels: () => record('listModels', [], port.models),

    setModel(sessionId: SessionId, model: ModelId): Promise<void> {
      calls.push({ op: 'setModel', args: [sessionId, model] })
      changeSession(sessionId, (session) => ({
        ...session,
        model,
        thinkingLevel: port.models.find((candidate) => candidate.id === model)?.thinkingLevels[0]
      }))
      emitState()
      return Promise.resolve()
    },

    setThinkingLevel(sessionId: SessionId, level: ThinkingLevel): Promise<void> {
      calls.push({ op: 'setThinkingLevel', args: [sessionId, level] })
      changeSession(sessionId, (session) => ({ ...session, thinkingLevel: level }))
      emitState()
      return Promise.resolve()
    },

    prompt(sessionId: SessionId, text: string): Promise<TurnId> {
      calls.push({ op: 'prompt', args: [sessionId, text] })
      const turnId = `t-${(minted += 1)}`
      turns.set(sessionId, turnId)
      changeSession(sessionId, (session) => ({ ...session, working: true }))
      emit({ type: 'turn_started', sessionId, turnId })
      emitState()
      return Promise.resolve(turnId)
    },

    cancel(sessionId: SessionId): Promise<void> {
      calls.push({ op: 'cancel', args: [sessionId] })
      if (turns.has(sessionId)) {
        finish(sessionId, { type: 'turn_cancelled', sessionId, turnId: turn(sessionId) })
      }
      return Promise.resolve()
    },

    update(change): void {
      snapshot = change(snapshot)
      emitState()
    },

    emit,

    turnOf: (sessionId) => turns.get(sessionId),

    text(sessionId, delta) {
      emit({ type: 'text_delta', sessionId, turnId: turn(sessionId), delta })
    },

    thinking(sessionId, delta) {
      emit({ type: 'thinking_delta', sessionId, turnId: turn(sessionId), delta })
    },

    toolStarted(sessionId, callId, name, summary) {
      emit({ type: 'tool_started', sessionId, turnId: turn(sessionId), callId, name, summary })
    },

    toolOutput(sessionId, callId, chunk) {
      emit({ type: 'tool_output', sessionId, turnId: turn(sessionId), callId, chunk })
    },

    toolEnded(sessionId, callId, ok, output) {
      emit({ type: 'tool_ended', sessionId, turnId: turn(sessionId), callId, ok, output })
    },

    endTurn(sessionId) {
      finish(sessionId, { type: 'turn_ended', sessionId, turnId: turn(sessionId) })
    },

    failTurn(sessionId, message) {
      finish(sessionId, { type: 'turn_error', sessionId, turnId: turn(sessionId), message })
    }
  }

  return port
}

export function oneSession(
  overrides: Partial<SessionState> = {}
): Pick<ShellSnapshot, 'workspaces' | 'sessions' | 'activeWorkspaceId' | 'activeSessionId'> {
  return {
    workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
    activeWorkspaceId: 'w1',
    sessions: [{ id: 's1', workspaceId: 'w1', createdAt: NOW, working: false, ...overrides }],
    activeSessionId: 's1'
  }
}
