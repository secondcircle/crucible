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

/**
 * The shell: main's implementation of the agent port, and the ordering
 * authority behind it (ADR 0003).
 *
 * It composes the two halves the port is made of — the shell store above, which
 * owns workspaces, curated membership and activation, and the adapter below,
 * which owns conversations — and it is the only place that knows both. What it
 * adds on top of them is the part neither can hold alone:
 *
 * - **One live turn per session, any number of sessions live at once** (A18).
 *   The guard is per session and it is enforced here, not in the UI and not by
 *   an adapter's own limitation.
 * - **Turn identity.** A turn id is minted when a prompt is accepted and handed
 *   down, so nothing has to be correlated afterwards and an adapter cannot
 *   start a turn nobody asked for. An event carrying an id that is not this
 *   session's live turn is dropped: that is what makes a cancelled turn silent
 *   after its terminal event, and a stale one harmless (A3).
 * - **The snapshot.** Store facts and adapter facts are merged into one value,
 *   and every `state` event carries the whole of it, so a late one always
 *   supersedes an earlier one.
 * - **Lazy binding.** A curated session is bound to its conversation the first
 *   time this launch needs it — a transcript, a prompt, a model change — rather
 *   than all at once at launch, so opening the app costs nothing per remembered
 *   session. A turn accepted while its session is still binding belongs to the
 *   shell alone until the bind resolves, so a stop, a reset or a removal in
 *   that window ends it here and the adapter is never asked to run work the
 *   user has already stopped. What the adapter reports back about a rebind
 *   (its token, the model and level it actually restored) is written into the
 *   store: after a rebind the adapter's word wins.
 *
 * Everything it takes is an argument — the store, the adapter, the folder
 * picker, the seed workspace — so the whole of it is unit-testable in plain
 * node with a temp file and a fake.
 */

/** The port, plus the one operation its owner needs and its callers never see. */
export interface Shell extends AgentPort {
  /**
   * Abandon the work in flight — the document that asked for it is gone —
   * without ending the shell. Live turns are dropped and say nothing more, the
   * per-session guards fall, and the store and its bindings stand, so the
   * document that comes back after a reload prompts immediately. Idempotent,
   * and doing it with nothing in flight is allowed and does nothing.
   */
  dispose(): void
}

export interface ShellOptions {
  readonly store: ShellStore
  readonly adapter: ConversationAdapter
  /** Opens the OS folder picker; `null` means the user cancelled (WS-1). */
  readonly pickFolder: () => Promise<string | null>
  /**
   * A folder to ensure present and active at launch, exactly as if it had been
   * picked (WS-7). It is what lets an agent-driven check reach a chattable
   * state without an OS dialog.
   */
  readonly seedWorkspacePath?: string
}

/** The turn this session is running right now, as far as the port is concerned. */
interface LiveTurn {
  readonly turnId: TurnId
  /** Whether `turn_started` has already been sent for it. */
  started: boolean
  /**
   * Whether the adapter has been asked to run it. False for the whole of the
   * bind that precedes the run: the window in which the session is already
   * working to everything above the port while the adapter has never heard of
   * the turn.
   */
  dispatched: boolean
  /**
   * Whether a stop has been asked for it. A dispatched turn is stopped by the
   * adapter, which says so with its own terminal event; an undispatched one is
   * ended here, and the mark is what keeps it from being dispatched later.
   */
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
  /** Sessions bound to a conversation this launch, by the bind in flight. */
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

  /** A refusal a person can read; the cause, if there is one, went to the log. */
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

  /**
   * The session's conversation, bound if this launch has not bound it yet. The
   * promise is remembered rather than the result, so two callers racing for the
   * same session bind it once.
   */
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
        // what the store and the snapshot then say (2.5).
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

  /**
   * End a turn the adapter never ran, as cancelled: the start it is owed, then
   * its terminal event, then the snapshot that says the session is idle again.
   */
  function endAsCancelled(sessionId: SessionId, turn: LiveTurn): void {
    live.delete(sessionId)
    if (!turn.started) {
      turn.started = true
      emit({ type: 'turn_started', sessionId, turnId: turn.turnId })
    }
    emit({ type: 'turn_cancelled', sessionId, turnId: turn.turnId })
    emitState()
  }

  /**
   * Stop a session's live turn and wait for the stop to have landed.
   *
   * A turn is live from the moment its prompt is accepted (2.3), which is
   * before the bind that precedes it has resolved, and on the SDK flavor that
   * bind is seconds long. Forwarding to the adapter is right only once the
   * adapter is running the turn; until then the adapter has nothing to cancel,
   * so the turn ends here instead, immediately (CAN-1), and the bind's
   * continuation finds it gone and never asks the adapter to run it (CAN-6).
   */
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

  // Everything the adapter says, filtered down to the turn that is live. The
  // subscription is the shell's own and lasts as long as the launch: it records
  // what the adapter did, not what some document happened to be watching.
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
    // An event for a turn that is not live belongs to a turn that has already
    // ended, been cancelled, or been abandoned with its document. It is dropped
    // here, which is what makes "nothing after the terminal event" true whoever
    // is behind the port.
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

  // WS-7: the seeded workspace is added exactly as a picked one would be, which
  // also makes it the active workspace.
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
      // A cancelled picker changes nothing at all — no state event, no
      // activation (WS-1).
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
        // Live work in a workspace being removed is stopped rather than left
        // running unseen; its conversation stays in adapter history (WS-4).
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
          // A new session starts on Crucible's last selection when the adapter
          // can still reach it, and on the adapter's fallback otherwise (MO-4).
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
      // Removal forgets the sidebar entry only: adapter-managed persistence is
      // untouched and the conversation can be resumed again later (A24).
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

      // A conversation that is already a curated session is activated rather
      // than added twice (RES-5). Whether two opaque strings name the same
      // conversation is the adapter's question, not this module's.
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
      // Model and thinking level belong to the session and change between
      // turns, never during one (MO-6). The guard is read again after the bind,
      // because a turn can start while a first-time bind is in flight.
      if (live.has(sessionId)) refuse('That session is working. Stop it first.')
      await ensureBound(sessionId)
      if (live.has(sessionId)) refuse('That session is working. Stop it first.')
      await adapter.setModel(sessionId, model)
      store.updateSession(sessionId, { model })
      // Crucible remembers the last selection, which is where a new session
      // starts (MO-4).
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
      // The guard is read before anything else, and the turn takes it in the
      // same tick: a session is working from the moment its prompt is accepted,
      // so nothing can slip between the check and the claim.
      if (live.has(sessionId)) refuse('That session is already working.')

      turns += 1
      const turnId = `t-${turns}`
      const turn: LiveTurn = { turnId, started: false, dispatched: false, cancelled: false }
      live.set(sessionId, turn)
      emitState()

      // Binding is part of running the turn rather than of accepting it: a
      // conversation that cannot be opened is this turn's error, which is the
      // one place a person will see it.
      void ensureBound(sessionId)
        .then(async () => {
          // The turn may no longer be this session's live one: a stop, a reset,
          // a removal or a document going away while the bind was in flight has
          // already ended it. The adapter is then never asked to run it, which
          // is what keeps a stopped turn from streaming on, and on the SDK
          // flavor from being paid for (CAN-1, CAN-6, SE-7, WS-4).
          if (live.get(sessionId) !== turn) return
          turn.dispatched = true
          await adapter.prompt(sessionId, turnId, text)
        })
        .then(() => {
          // A turn the adapter finished without saying so still ends exactly
          // once, and it ends here.
          if (live.get(sessionId) !== turn) return
          // A stop was asked for and the adapter returned without saying how
          // the turn ended: cancelled is the honest outcome, not a normal end
          // (A3).
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
          // Likewise for a rejection after a stop: an abort is the stop
          // landing, not a failure to show anyone (A3).
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
      // Targeted, and harmless when it loses the race or names a session with
      // nothing running (A3).
      await stop(sessionId)
    },

    dispose(): void {
      live.clear()
      adapter.dispose()
    }
  }
}
