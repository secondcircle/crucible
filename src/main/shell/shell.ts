import { basename } from 'node:path'
import type { Binding, ConversationAdapter } from '../../shared/agent/adapter'
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
  Unsubscribe,
  WorkspaceId
} from '../../shared/agent/port'
import { displaySafeMessage } from '../agent/adapter-error'
import type { ShellStore } from './store'

// Turn guards and ordering live here rather than in the UI or an adapter, so
// they hold whoever is behind the port.
export interface Shell extends AgentPort {
  // Drops live turns but keeps bindings, so the document that comes back after
  // a reload can prompt immediately.
  dispose(): void
}

export interface ShellOptions {
  readonly store: ShellStore
  readonly adapter: ConversationAdapter
  /** `null` means the user cancelled the picker. */
  readonly pickFolder: () => Promise<string | null>
  // Lets an agent-driven check reach a chattable state without an OS dialog.
  readonly seedWorkspacePath?: string
}

interface LiveTurn {
  readonly turnId: TurnId
  started: boolean
  // False for the whole of the bind that precedes the run: the session is
  // working to everyone above the port while the adapter has never heard of
  // the turn.
  dispatched: boolean
  // A dispatched turn is stopped by the adapter and says so itself; an
  // undispatched one is ended here, and this mark keeps it from being
  // dispatched afterwards.
  cancelled: boolean
}

export function createShell({
  store,
  adapter,
  pickFolder,
  seedWorkspacePath
}: ShellOptions): Shell {
  const listeners = new Set<PortEventListener>()
  const live = new Map<SessionId, LiveTurn>()
  const usage = new Map<SessionId, { usedTokens: number; contextWindow: number }>()
  const bindings = new Map<SessionId, Promise<Binding>>()
  let turns = 0

  function emit(event: PortEvent): void {
    // A copy, so a listener that unsubscribes while being called does not
    // disturb the delivery of that same event to the others.
    for (const listener of [...listeners]) listener(event)
  }

  function snapshot(): ShellSnapshot {
    const sessions: SessionState[] = store.state.sessions.map((session) => {
      const reported = usage.get(session.id)
      return {
        id: session.id,
        workspaceId: session.workspaceId,
        createdAt: session.createdAt,
        model: session.model,
        thinkingLevel: session.thinkingLevel,
        working: live.has(session.id),
        ...(reported === undefined ? {} : { usage: reported })
      }
    })

    return {
      workspaces: store.state.workspaces.map((workspace) => ({
        id: workspace.id,
        name: basename(workspace.path),
        path: workspace.path
      })),
      activeWorkspaceId: store.state.activeWorkspaceId,
      sessions,
      activeSessionId: store.activeSessionId()
    }
  }

  function emitState(): void {
    emit({ type: 'state', snapshot: snapshot() })
  }

  function refuse(message: string): never {
    throw new Error(message)
  }

  function requireSession(id: SessionId): { workspacePath: string } {
    const session = store.session(id)
    if (session === undefined) refuse('That session is no longer open.')
    const workspace = store.workspace(session.workspaceId)
    if (workspace === undefined) refuse('That session has no workspace.')
    return { workspacePath: workspace.path }
  }

  // The promise is remembered rather than the result, so two callers racing
  // for the same session bind it once.
  function ensureBound(id: SessionId): Promise<Binding> {
    const already = bindings.get(id)
    if (already !== undefined) return already

    const { workspacePath } = requireSession(id)
    const session = store.session(id)
    const binding = adapter
      .bind({
        sessionId: id,
        workspacePath,
        token: session?.token,
        preferredModel: session?.model ?? store.state.lastModel,
        preferredThinkingLevel: session?.thinkingLevel
      })
      .then((bound) => {
        // After a rebind the adapter's word wins: what it says it restored is
        // what the store then says.
        store.updateSession(id, {
          token: bound.token,
          model: bound.model,
          thinkingLevel: bound.thinkingLevel
        })
        emitState()
        return bound
      })
      .catch((cause: unknown) => {
        // A failed bind is not remembered: the next attempt tries again.
        bindings.delete(id)
        throw new Error(displaySafeMessage(cause, 'That conversation could not be opened.'))
      })

    bindings.set(id, binding)
    return binding
  }

  // A turn the adapter never ran still owes its listeners a start before its
  // terminal event.
  function endAsCancelled(sessionId: SessionId, turn: LiveTurn): void {
    live.delete(sessionId)
    if (!turn.started) {
      turn.started = true
      emit({ type: 'turn_started', sessionId, turnId: turn.turnId })
    }
    emit({ type: 'turn_cancelled', sessionId, turnId: turn.turnId })
    emitState()
  }

  // A turn is live from the moment its prompt is accepted, which on the SDK
  // flavor is seconds before its bind resolves; until the adapter is running
  // it there is nothing there to cancel, so it ends here instead.
  async function stop(id: SessionId): Promise<void> {
    const turn = live.get(id)
    if (turn === undefined) return
    turn.cancelled = true
    if (!turn.dispatched) {
      endAsCancelled(id, turn)
      return
    }
    await adapter.cancel(id)
  }

  // The subscription is the shell's own and lasts as long as the launch: it
  // records what the adapter did, not what some document happened to watch.
  adapter.onEvent((event) => {
    if (event.type === 'usage') {
      usage.set(event.sessionId, {
        usedTokens: event.usedTokens,
        contextWindow: event.contextWindow
      })
      emitState()
      return
    }

    const turn = live.get(event.sessionId)
    // Dropping events for turns that are no longer live is what makes "nothing
    // after the terminal event" true whoever is behind the port.
    if (turn === undefined || turn.turnId !== event.turnId) return

    if (event.type === 'turn_started') {
      if (turn.started) return
      turn.started = true
      emit(event)
      return
    }

    if (!turn.started) {
      // No adapter should stream before it starts a turn; if one does, the
      // start is still said exactly once and first.
      turn.started = true
      emit({ type: 'turn_started', sessionId: event.sessionId, turnId: event.turnId })
    }

    if (event.type === 'turn_ended' || event.type === 'turn_cancelled') {
      live.delete(event.sessionId)
      emit(event)
      emitState()
      return
    }
    if (event.type === 'turn_error') {
      live.delete(event.sessionId)
      emit({
        type: 'turn_error',
        sessionId: event.sessionId,
        turnId: event.turnId,
        message: displaySafeMessage(event.message, 'The agent failed without saying why.')
      })
      emitState()
      return
    }

    emit(event)
  })

  // Seeded exactly as a picked folder would be, so it also becomes active.
  if (seedWorkspacePath !== undefined) store.addWorkspace(seedWorkspacePath)

  return {
    async snapshot(): Promise<ShellSnapshot> {
      return snapshot()
    },

    onEvent(listener: PortEventListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async addWorkspace(): Promise<WorkspaceId | null> {
      const path = await pickFolder()
      // A cancelled picker changes nothing at all: no state event, no
      // activation.
      if (path === null || path === '') return null
      const workspace = store.addWorkspace(path)
      emitState()
      return workspace.id
    },

    async activateWorkspace(id: WorkspaceId): Promise<void> {
      store.activateWorkspace(id)
      emitState()
    },

    async removeWorkspace(id: WorkspaceId): Promise<void> {
      const sessions = store.state.sessions.filter((session) => session.workspaceId === id)
      for (const session of sessions) {
        // Stopped rather than left running unseen; the conversation itself
        // stays in adapter history.
        await stop(session.id)
        adapter.release(session.id)
        bindings.delete(session.id)
        usage.delete(session.id)
      }
      store.removeWorkspace(id)
      emitState()
    },

    async createSession(workspaceId: WorkspaceId): Promise<SessionId> {
      const workspace = store.workspace(workspaceId)
      if (workspace === undefined) refuse('That workspace is no longer open.')

      const stored = store.addSession({
        workspaceId,
        createdAt: new Date().toISOString()
      })
      try {
        const bound = await adapter.bind({
          sessionId: stored.id,
          workspacePath: workspace.path,
          // The last selection is a preference, not a demand: an adapter that
          // cannot reach it falls back.
          preferredModel: store.state.lastModel
        })
        bindings.set(stored.id, Promise.resolve(bound))
        store.updateSession(stored.id, {
          token: bound.token,
          model: bound.model,
          thinkingLevel: bound.thinkingLevel
        })
      } catch (cause) {
        // A session that could not be given a conversation is not a session:
        // the sidebar does not keep an entry that could never be prompted.
        store.removeSession(stored.id)
        emitState()
        refuse(displaySafeMessage(cause, 'A new session could not be started.'))
      }
      emitState()
      return stored.id
    },

    async activateSession(id: SessionId): Promise<void> {
      store.activateSession(id)
      emitState()
    },

    async removeSession(id: SessionId): Promise<void> {
      await stop(id)
      // Removal forgets the sidebar entry only: the conversation is left where
      // it is and can be resumed later.
      adapter.release(id)
      bindings.delete(id)
      usage.delete(id)
      store.removeSession(id)
      emitState()
    },

    async resetSession(id: SessionId): Promise<void> {
      requireSession(id)
      await stop(id)
      await ensureBound(id)
      const bound = await adapter.reset(id)
      bindings.set(id, Promise.resolve(bound))
      store.updateSession(id, {
        token: bound.token,
        model: bound.model,
        thinkingLevel: bound.thinkingLevel
      })
      // The fresh conversation has reported nothing yet, so the meter goes back
      // to saying nothing rather than keeping the old session's numbers.
      usage.delete(id)
      emitState()
    },

    async transcript(id: SessionId): Promise<readonly TranscriptItem[]> {
      await ensureBound(id)
      return adapter.transcript(id)
    },

    async searchHistory(
      workspaceId: WorkspaceId,
      query: string
    ): Promise<readonly HistoryMatch[]> {
      const workspace = store.workspace(workspaceId)
      if (workspace === undefined) refuse('That workspace is no longer open.')
      return adapter.searchHistory(workspace.path, query)
    },

    async resumeSession(workspaceId: WorkspaceId, ref: string): Promise<SessionId> {
      const workspace = store.workspace(workspaceId)
      if (workspace === undefined) refuse('That workspace is no longer open.')

      // Whether two opaque tokens name the same conversation is the adapter's
      // question, not this module's.
      const existing = store.state.sessions.find(
        (session) =>
          session.workspaceId === workspaceId &&
          session.token !== undefined &&
          adapter.sameConversation(session.token, ref)
      )
      if (existing !== undefined) {
        store.activateSession(existing.id)
        emitState()
        return existing.id
      }

      const stored = store.addSession({ workspaceId, createdAt: new Date().toISOString() })
      try {
        const bound = await adapter.resume({
          sessionId: stored.id,
          workspacePath: workspace.path,
          ref
        })
        bindings.set(stored.id, Promise.resolve(bound))
        store.updateSession(stored.id, {
          token: bound.token,
          model: bound.model,
          thinkingLevel: bound.thinkingLevel
        })
      } catch (cause) {
        store.removeSession(stored.id)
        emitState()
        refuse(displaySafeMessage(cause, 'That conversation could not be resumed.'))
      }
      emitState()
      return stored.id
    },

    listModels(): Promise<readonly ModelInfo[]> {
      return adapter.listModels()
    },

    async setModel(sessionId: SessionId, model: ModelId): Promise<void> {
      requireSession(sessionId)
      // Read again after the bind, because a turn can start while a first-time
      // bind is in flight.
      if (live.has(sessionId)) refuse('That session is working. Stop it first.')
      await ensureBound(sessionId)
      if (live.has(sessionId)) refuse('That session is working. Stop it first.')
      await adapter.setModel(sessionId, model)
      store.updateSession(sessionId, { model })
      store.setLastModel(model)
      emitState()
    },

    async setThinkingLevel(sessionId: SessionId, level: ThinkingLevel): Promise<void> {
      requireSession(sessionId)
      if (live.has(sessionId)) refuse('That session is working. Stop it first.')
      await ensureBound(sessionId)
      if (live.has(sessionId)) refuse('That session is working. Stop it first.')
      await adapter.setThinkingLevel(sessionId, level)
      store.updateSession(sessionId, { thinkingLevel: level })
      emitState()
    },

    async prompt(sessionId: SessionId, text: string): Promise<TurnId> {
      requireSession(sessionId)
      // Checked and claimed in the same tick, so nothing can slip between the
      // two.
      if (live.has(sessionId)) refuse('That session is already working.')

      turns += 1
      const turnId = `t-${turns}`
      const turn: LiveTurn = { turnId, started: false, dispatched: false, cancelled: false }
      live.set(sessionId, turn)
      emitState()

      // Binding is part of running the turn rather than of accepting it, so a
      // conversation that cannot be opened surfaces as this turn's error.
      void ensureBound(sessionId)
        .then(async () => {
          // A stop, reset or removal during the bind already ended this turn,
          // and the adapter must never be asked to run work the user stopped.
          if (live.get(sessionId) !== turn) return
          turn.dispatched = true
          await adapter.prompt(sessionId, turnId, text)
        })
        .then(() => {
          // A turn the adapter finished without saying so still ends exactly
          // once, and it ends here.
          if (live.get(sessionId) !== turn) return
          // The adapter returned without saying how a stopped turn ended:
          // cancelled is the honest outcome, not a normal end.
          if (turn.cancelled) {
            endAsCancelled(sessionId, turn)
            return
          }
          live.delete(sessionId)
          if (!turn.started) emit({ type: 'turn_started', sessionId, turnId })
          emit({ type: 'turn_ended', sessionId, turnId })
          emitState()
        })
        .catch((cause: unknown) => {
          if (live.get(sessionId) !== turn) return
          // A rejection after a stop is the stop landing, not a failure to
          // show anyone.
          if (turn.cancelled) {
            endAsCancelled(sessionId, turn)
            return
          }
          live.delete(sessionId)
          if (!turn.started) emit({ type: 'turn_started', sessionId, turnId })
          emit({
            type: 'turn_error',
            sessionId,
            turnId,
            message: displaySafeMessage(cause, 'The agent failed without saying why.')
          })
          emitState()
        })

      return turnId
    },

    async cancel(sessionId: SessionId): Promise<void> {
      // Harmless when it loses the race or names a session with nothing
      // running.
      await stop(sessionId)
    },

    dispose(): void {
      live.clear()
      adapter.dispose()
    }
  }
}
