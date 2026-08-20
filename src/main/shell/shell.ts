import { basename } from 'node:path'
import type { Binding, ConversationAdapter } from '../../shared/agent/adapter'
import type {
  AgentPort,
  AuthMethod,
  BashRunShare,
  HistoryMatch,
  ImageAttachment,
  ModelId,
  ModelInfo,
  PortEvent,
  PortEventListener,
  ProviderState,
  QueuedKind,
  QueueState,
  SessionId,
  SessionState,
  SessionTree,
  SessionUsage,
  ShellSnapshot,
  TabId,
  ThinkingLevel,
  TranscriptItem,
  TurnId,
  Unsubscribe,
  WorkspaceId
} from '../../shared/agent/port'
import { displaySafeMessage } from '../agent/adapter-error'
import type { PanelModel } from '../panel/model'
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
  // The same model the adapter's panel tools call, so panel state crosses the
  // port from here and from nowhere else.
  readonly panel: PanelModel
  /** `null` means the user cancelled the picker. */
  readonly pickFolder: () => Promise<string | null>
  // Lets an agent-driven check reach a chattable state without an OS dialog.
  readonly seedWorkspacePath?: string
}

// What this shell put into the conversation itself and therefore owes an
// announcement for; a caller of `prompt()` echoes its own message and needs none.
type Announcement =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'bashRun'; readonly run: BashRunShare }

// 'stopped' is every end the user asked for. Work parked on a turn has to know
// the difference: nothing may auto-fire at a plan the user killed.
type TurnOutcome = 'ended' | 'stopped'

interface LiveTurn {
  readonly turnId: TurnId
  started: boolean
  // False for the whole of the bind: the session is working above the port
  // while the adapter has never heard of the turn.
  dispatched: boolean
  // An undispatched turn is ended here rather than by the adapter, and this
  // mark keeps it from being dispatched afterwards.
  cancelled: boolean
  // Set when this turn carries something nobody echoed, which is then
  // announced right after the turn starts.
  readonly announce?: Announcement
  /** Resolves, with why, when the shell stops treating this turn as live. */
  readonly over: Promise<TurnOutcome>
  settled(outcome: TurnOutcome): void
}

function queued(queue: QueueState | undefined): boolean {
  return queue !== undefined && queue.steering.length + queue.followUp.length > 0
}

export function createShell({
  store,
  adapter,
  panel,
  pickFolder,
  seedWorkspacePath
}: ShellOptions): Shell {
  const listeners = new Set<PortEventListener>()
  const live = new Map<SessionId, LiveTurn>()
  // The cost rides in the same fold as the tokens: absent until the adapter
  // has genuinely reported it.
  const usage = new Map<
    SessionId,
    { usedTokens: number; contextWindow: number; cost?: number }
  >()
  // Folded from `queue_changed` exactly as usage is, so the strip renders from
  // the snapshot and survives both a session switch and a renderer reload.
  const queues = new Map<SessionId, QueueState>()
  // Removing a session stops its turn, and a stop hands the queue back, which
  // a session on its way out has no composer left to receive.
  const removing = new Set<SessionId>()
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
      const queue = queues.get(session.id)
      // Folded exactly as the queue is, and absent when the session has no
      // tabs, which is what makes the region vanish rather than stand empty.
      const tabs = panel.state(session.id)
      return {
        id: session.id,
        workspaceId: session.workspaceId,
        createdAt: session.createdAt,
        model: session.model,
        thinkingLevel: session.thinkingLevel,
        working: live.has(session.id),
        ...(reported === undefined ? {} : { usage: reported }),
        ...(queued(queue) ? { queue } : {}),
        ...(tabs === undefined ? {} : { panel: tabs })
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

  function mintTurn(announce?: Announcement): LiveTurn {
    turns += 1
    let settled: (outcome: TurnOutcome) => void = () => {}
    const over = new Promise<TurnOutcome>((resolve) => {
      settled = resolve
    })
    return {
      turnId: `t-${turns}`,
      started: false,
      dispatched: false,
      cancelled: false,
      announce,
      over,
      settled
    }
  }

  // The one place a turn stops being live, so nothing waiting on `over` is
  // left waiting.
  function endTurn(sessionId: SessionId, turn: LiveTurn): void {
    live.delete(sessionId)
    turn.settled(turn.cancelled ? 'stopped' : 'ended')
  }

  // A message this shell put into the conversation itself is announced right
  // after the start, because no caller of `prompt()` echoed it.
  function announceStart(sessionId: SessionId, turn: LiveTurn): void {
    if (turn.started) return
    turn.started = true
    const turnId = turn.turnId
    emit({ type: 'turn_started', sessionId, turnId })
    const announce = turn.announce
    if (announce === undefined) return
    if (announce.kind === 'text') {
      emit({ type: 'user_message', sessionId, turnId, text: announce.text })
      return
    }
    // A shared bash run is not a user message and never reads as one.
    emit({
      type: 'bash_run_shared',
      sessionId,
      turnId,
      command: announce.run.command,
      output: announce.run.output,
      ...(announce.run.exitCode === undefined ? {} : { exitCode: announce.run.exitCode })
    })
  }

  // A turn the adapter never ran still owes its listeners a start before its
  // terminal event.
  function endAsCancelled(sessionId: SessionId, turn: LiveTurn): void {
    endTurn(sessionId, turn)
    announceStart(sessionId, turn)
    emit({ type: 'turn_cancelled', sessionId, turnId: turn.turnId })
    emitState()
  }

  // `announce` is what this shell delivered itself, and a plain prompt has
  // none because its caller echoed it.
  function beginTurn(
    sessionId: SessionId,
    dispatch: (turnId: TurnId) => Promise<void>,
    announce?: Announcement
  ): TurnId {
    requireSession(sessionId)
    // Checked and claimed in the same tick, so nothing can slip between the
    // two.
    if (live.has(sessionId)) refuse('That session is already working.')

    const turn = mintTurn(announce)
    const { turnId } = turn
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
        await dispatch(turnId)
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
        endTurn(sessionId, turn)
        announceStart(sessionId, turn)
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
        endTurn(sessionId, turn)
        announceStart(sessionId, turn)
        emit({
          type: 'turn_error',
          sessionId,
          turnId,
          message: displaySafeMessage(cause, 'The agent failed without saying why.')
        })
        emitState()
      })

    return turnId
  }

  // False whenever the message did not reach the live turn, so the caller can
  // offer it to the next turn rather than lose it with this one.
  async function offerToTurn(
    sessionId: SessionId,
    kind: QueuedKind,
    text: string,
    turn: LiveTurn
  ): Promise<boolean> {
    try {
      // A turn still binding has no adapter run behind it yet; waiting for the
      // bind is what keeps a message queued during one from being lost.
      await ensureBound(sessionId)
      if (live.get(sessionId) !== turn) return false
      const answer =
        kind === 'steering'
          ? await adapter.steer(sessionId, text)
          : await adapter.followUp(sessionId, text)
      return answer === 'queued'
    } catch {
      // The turn already reports a failed bind as its own error, and refusing
      // here would destroy the only copy of the text: the draft is cleared.
      return false
    }
  }

  // Never lost and never refused: with no live turn to take it, the message
  // becomes the next prompt and is announced as a user message itself.
  async function queueMessage(
    sessionId: SessionId,
    kind: QueuedKind,
    text: string
  ): Promise<void> {
    requireSession(sessionId)

    for (;;) {
      const turn = live.get(sessionId)
      if (turn === undefined) break
      if (await offerToTurn(sessionId, kind, text, turn)) return
      // Waited out and offered again, because a message the user typed is
      // never lost whichever way the turn ended.
      await turn.over
    }

    beginTurn(sessionId, (turnId) => adapter.prompt(sessionId, turnId, text), {
      kind: 'text',
      text
    })
    // A queued message with no turn left to take it becomes the next prompt,
    // and a prompt is a user instruction whatever key sent it.
    panel.bumpTurn(sessionId)
  }

  // A run is never lost and never queued: a live turn takes it, or it starts a
  // turn of its own, or the turn it was offered to stopped and it stays local.
  async function shareRun(
    sessionId: SessionId,
    share: BashRunShare
  ): Promise<'delivered' | 'dropped'> {
    requireSession(sessionId)

    for (;;) {
      const turn = live.get(sessionId)
      if (turn === undefined) break
      await ensureBound(sessionId)
      // A turn that ended while the bind was in flight is waited out below all
      // the same, because how it ended decides as much as an answer would have.
      if (live.get(sessionId) === turn) {
        const answer = await adapter.shareBashRun(sessionId, share)
        if (answer === 'dropped') return 'dropped'
        if (answer === 'delivered') {
          // The delivery point, which is the only place this may be said.
          emit({
            type: 'bash_run_shared',
            sessionId,
            turnId: turn.turnId,
            command: share.command,
            output: share.output,
            ...(share.exitCode === undefined ? {} : { exitCode: share.exitCode })
          })
          return 'delivered'
        }
      }
      // A turn the user stopped takes the run down with it, whatever an
      // adapter answered: nothing fires at a plan the user killed.
      if ((await turn.over) === 'stopped') return 'dropped'
    }

    beginTurn(sessionId, (turnId) => adapter.promptBashRun(sessionId, turnId, share), {
      kind: 'bashRun',
      run: share
    })
    return 'delivered'
  }

  // A turn is live from the moment its prompt is accepted, seconds before its
  // bind resolves; until the adapter runs it there is nothing there to cancel.
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
    // Credentials belong to the machine rather than to any conversation, so
    // these events carry no session and pass straight through.
    if (
      event.type === 'auth_prompt' ||
      event.type === 'auth_prompt_closed' ||
      event.type === 'auth_notice'
    ) {
      emit(event)
      return
    }

    if (event.type === 'usage') {
      usage.set(event.sessionId, {
        usedTokens: event.usedTokens,
        contextWindow: event.contextWindow,
        ...(event.cost === undefined ? {} : { cost: event.cost })
      })
      emitState()
      return
    }

    // Queue events are session-scoped like usage: they belong to the session
    // rather than to whichever turn happens to be live.
    if (event.type === 'queue_changed') {
      queues.set(event.sessionId, { steering: event.steering, followUp: event.followUp })
      emitState()
      return
    }
    if (event.type === 'queue_flushed') {
      queues.delete(event.sessionId)
      // A session on its way out has nowhere to restore a message to, and the
      // removal emits the state that follows it.
      if (removing.has(event.sessionId) || store.session(event.sessionId) === undefined) return
      emit(event)
      emitState()
      return
    }

    const turn = live.get(event.sessionId)
    // Dropping events for turns that are no longer live is what makes "nothing
    // after the terminal event" true whoever is behind the port.
    if (turn === undefined || turn.turnId !== event.turnId) return

    if (event.type === 'turn_started') {
      if (turn.started) return
      announceStart(event.sessionId, turn)
      return
    }

    // No adapter should stream before it starts a turn; if one does, the start
    // is still said exactly once and first.
    announceStart(event.sessionId, turn)

    if (event.type === 'turn_ended' || event.type === 'turn_cancelled') {
      endTurn(event.sessionId, turn)
      emit(event)
      emitState()
      return
    }
    if (event.type === 'turn_error') {
      endTurn(event.sessionId, turn)
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

  // The snapshot goes out before the show, so a listener already holds the
  // state the event names. A background session's shows are announced too.
  panel.onChange(({ sessionId, shownTabId }) => {
    if (store.session(sessionId) === undefined) return
    emitState()
    if (shownTabId !== undefined) emit({ type: 'panel_shown', sessionId, tabId: shownTabId })
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
        removing.add(session.id)
        try {
          await stop(session.id)
          adapter.release(session.id)
        } finally {
          removing.delete(session.id)
        }
        bindings.delete(session.id)
        usage.delete(session.id)
        queues.delete(session.id)
        // The panel record leaves with the session record below; this is the
        // memory of it.
        panel.forget(session.id)
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
      // Marked before the stop, because a stop hands the queue back and
      // removal is the one case where that hand-back has nowhere to land.
      removing.add(id)
      try {
        await stop(id)
        // Removal forgets the sidebar entry only: the conversation is left
        // where it is and can be resumed later.
        adapter.release(id)
        store.removeSession(id)
      } finally {
        removing.delete(id)
      }
      bindings.delete(id)
      usage.delete(id)
      // A queue has nowhere to be restored to once the entry holding it is
      // gone.
      queues.delete(id)
      // Removing a session forgets its tabs with it: the persisted copy went
      // out with the session record.
      panel.forget(id)
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
      queues.delete(id)
      // A fresh conversation never inherits a ghost panel, so the tabs and the
      // turn counter go with the old one.
      panel.reset(id)
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

    // Browsing is allowed whatever the session is doing: opening the tree
    // never touches a live turn.
    async sessionTree(id: SessionId): Promise<SessionTree> {
      requireSession(id)
      await ensureBound(id)
      return adapter.sessionTree(id)
    },

    async jump(
      id: SessionId,
      ref: string,
      options: { readonly summarize: boolean }
    ): Promise<{ editorText?: string }> {
      requireSession(id)
      // Read again after the bind, because a turn can start while a first-time
      // bind is in flight.
      if (live.has(id)) refuse('That session is working. Stop it first.')
      await ensureBound(id)
      if (live.has(id)) refuse('That session is working. Stop it first.')
      const jumped = await adapter.jump(id, ref, options.summarize)
      // The conversation behind the identity moved; the sidebar entry did not.
      usage.delete(id)
      emitState()
      return jumped
    },

    async setLabel(id: SessionId, ref: string, label?: string): Promise<void> {
      requireSession(id)
      await ensureBound(id)
      await adapter.setLabel(id, ref, label)
    },

    listModels(): Promise<readonly ModelInfo[]> {
      return adapter.listModels()
    },

    listProviders(): Promise<readonly ProviderState[]> {
      return adapter.listProviders()
    },

    async login(providerId: string, method: AuthMethod): Promise<void> {
      await adapter.login(providerId, method)
    },

    async answerAuthPrompt(promptId: string, value: string): Promise<void> {
      await adapter.answerAuthPrompt(promptId, value)
    },

    async cancelLogin(): Promise<void> {
      await adapter.cancelLogin()
    },

    async logout(providerId: string): Promise<void> {
      await adapter.logout(providerId)
    },

    // Curated sessions only, bound or not: the token is the adapter's own
    // string and stays opaque on the way through.
    async sessionUsage(id: SessionId): Promise<SessionUsage | undefined> {
      const session = store.session(id)
      if (session === undefined) return undefined
      const workspace = store.workspace(session.workspaceId)
      if (workspace === undefined) return undefined
      return adapter.sessionUsage({
        sessionId: id,
        workspacePath: workspace.path,
        ...(session.token === undefined ? {} : { token: session.token })
      })
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

    // Async so that a refusal crosses the port as a rejection rather than as a
    // synchronous throw.
    async prompt(
      sessionId: SessionId,
      text: string,
      images?: readonly ImageAttachment[]
    ): Promise<TurnId> {
      const started = beginTurn(sessionId, (turnId) =>
        adapter.prompt(sessionId, turnId, text, images)
      )
      // One user instruction, one turn on the panel's counter: it is what
      // "shown N turns ago" counts.
      panel.bumpTurn(sessionId)
      return started
    },

    async shareBashRun(
      sessionId: SessionId,
      share: BashRunShare
    ): Promise<'delivered' | 'dropped'> {
      return shareRun(sessionId, share)
    },

    async steer(sessionId: SessionId, text: string): Promise<void> {
      await queueMessage(sessionId, 'steering', text)
    },

    async followUp(sessionId: SessionId, text: string): Promise<void> {
      await queueMessage(sessionId, 'followUp', text)
    },

    async dequeue(sessionId: SessionId, kind: QueuedKind, text: string): Promise<boolean> {
      requireSession(sessionId)
      // Nothing can be queued behind a session that was never bound, and
      // binding one to say so would be work for no answer.
      if (bindings.get(sessionId) === undefined) return false
      await ensureBound(sessionId)
      return adapter.dequeue(sessionId, kind, text)
    },

    // Nothing is pushed at the agent: it learns of the user's own panel actions
    // at its next `panel_list` or `panel_show`.
    async activateTab(sessionId: SessionId, tabId: TabId): Promise<void> {
      if (store.session(sessionId) === undefined) return
      panel.activate(sessionId, tabId)
    },

    async closeTab(sessionId: SessionId, tabId: TabId): Promise<void> {
      if (store.session(sessionId) === undefined) return
      panel.closeTab(sessionId, tabId)
    },

    async exhibit(sessionId: SessionId, tabId: TabId): Promise<{ body: string }> {
      requireSession(sessionId)
      try {
        return { body: panel.exhibit(sessionId, tabId) }
      } catch (cause) {
        refuse(displaySafeMessage(cause, 'That exhibit could not be read.'))
      }
    },

    async cancel(sessionId: SessionId): Promise<void> {
      // Harmless when it loses the race or names a session with nothing
      // running.
      await stop(sessionId)
    },

    dispose(): void {
      // The launch is going away: work parked on these turns must not start
      // new ones behind it.
      for (const turn of live.values()) turn.settled('stopped')
      live.clear()
      adapter.dispose()
    }
  }
}
