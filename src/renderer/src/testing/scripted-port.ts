import type {
  AgentPort,
  AuthMethod,
  AuthNotice,
  AuthPromptKind,
  AuthPromptOption,
  BashRunShare,
  HistoryMatch,
  ImageAttachment,
  ModelId,
  ModelInfo,
  PanelState,
  PanelTab,
  PortEvent,
  PortEventListener,
  PromptOptions,
  ProviderState,
  Question,
  QuestionId,
  QuestionLine,
  QuestionReply,
  QueuedEntry,
  QueuedKind,
  QueuedMessage,
  QueueState,
  SessionId,
  SessionState,
  SessionTree,
  SessionUsage,
  SessionWorktree,
  ShellSnapshot,
  SystemCard,
  TabId,
  ThinkingLevel,
  TranscriptItem,
  TreeNode,
  TurnId,
  WorkspaceId
} from '../../../shared/agent/port'
import { composeAnswerBatch, type AnsweredQuestion } from '../../../shared/questions/wording'

// Answers operations the way main does but streams nothing by itself, so a
// component test is about rendering rather than about timing.
export interface ScriptedPort extends AgentPort {
  readonly calls: ReadonlyArray<{ readonly op: string; readonly args: readonly unknown[] }>
  /** The snapshot as it stands, which every `state` event carries whole. */
  readonly snapshotNow: ShellSnapshot
  models: readonly ModelInfo[]
  history: readonly HistoryMatch[]
  readonly transcripts: Map<SessionId, readonly TranscriptItem[]>
  /** What the folder picker will answer with; `null` is a cancelled picker. */
  folder: string | null
  /** What `sessionTree` answers with, per session. */
  readonly trees: Map<SessionId, SessionTree>
  /** What a jump hands back to the composer, and what the path becomes. */
  jumpText?: string
  /** Set where a test wants the refusal main gives a working session. */
  jumpRefusal?: string
  /** Set where a test wants the jump to answer as the user's own cancellation. */
  jumpCancelled?: boolean
  // Held open where a test wants a jump still in flight — a summarize takes
  // real seconds, and everything about owning one happens during them.
  holdJump?: boolean
  // Settles the oldest held jump, the way π settles one. Held jumps queue, so
  // a test can have two in flight at once and settle the one that started
  // first — which is how a chain outlives the screen that started it.
  settleJump(outcome: 'jumped' | 'cancelled' | { readonly failure: string }): void
  // Held open where a test wants the round trip a summarize door makes before
  // it asks π for anything: nothing has been spent yet during it, so what
  // Escape does elsewhere in that window is only visible here.
  holdTree?: boolean
  /** Answers one session's held tree read with the tree scripted for it. */
  settleTree(id: SessionId): void
  /** π's own retry of a branch summary, exactly as main announces one. */
  summarizeRetry(
    sessionId: SessionId,
    retry: {
      readonly attempt: number
      readonly maxAttempts: number
      readonly delayMs?: number
      readonly message: string
    }
  ): void
  /** Set where a test wants the refusal main gives a failed rebind. */
  worktreeRefusal?: string
  /** Set where a test wants a session main could not start. */
  createSessionRefusal?: string
  // Held open where a test wants the rebind still in flight: the change lands
  // when the test says so, the way it lands when main's bind comes back.
  holdWorktree?: boolean
  settleWorktreeChange(): void
  /** How the next `shareBashRun` settles; delivered unless a test says else. */
  shareOutcome: 'delivered' | 'dropped'
  // Held open where a test wants the waiting state: the promise settles when
  // the test says so.
  holdShare?: boolean
  /** Settles a held share, as the port does when it reaches its delivery point. */
  settleShare(outcome: 'delivered' | 'dropped'): void
  // Set only where a test needs the race main loses: a message delivered while
  // the click was in flight. Otherwise the double answers with what it removed.
  dequeueMisses?: boolean
  /** What `exhibit` answers with, per tab id. */
  readonly exhibits: Map<TabId, string>
  /** Set where a test wants a read main could not carry out. */
  exhibitRefusal?: string
  // A show the way main announces one: the tab lands in the snapshot, the
  // `state` event goes out, and `panel_shown` follows it.
  showTab(sessionId: SessionId, tab: PanelTab): void
  panelOf(sessionId: SessionId): PanelState | undefined

  // A question the way main announces one: the line lands in the snapshot,
  // the `state` event goes out, and `question_asked` follows it.
  askQuestion(sessionId: SessionId, question: Question): void
  questionsOf(sessionId: SessionId): QuestionLine | undefined

  /** What `listProviders` answers with; a test may change it between calls. */
  providers: readonly ProviderState[]
  /** What `sessionUsage` answers with, per session; absent means no numbers yet. */
  readonly usage: Map<SessionId, SessionUsage>
  /** True while a login the renderer started has not settled. */
  loginLive(): boolean
  /** Settles that login the way main does, with success or a display-safe message. */
  finishLogin(outcome: 'succeeded' | { readonly failure: string }): void
  /** A login's question, exactly as main announces one. */
  authPrompt(prompt: {
    readonly promptId: string
    readonly kind: AuthPromptKind
    readonly message: string
    readonly placeholder?: string
    readonly options?: readonly AuthPromptOption[]
  }): void
  /** The flow resolved a pending question out of band. */
  closeAuthPrompt(promptId: string): void
  authNotice(notice: AuthNotice): void

  update(change: (snapshot: ShellSnapshot) => ShellSnapshot): void
  emit(event: PortEvent): void

  turnOf(sessionId: SessionId): TurnId | undefined
  /** Announces a shared run at its delivery point, the way main does. */
  bashRunShared(sessionId: SessionId, run: BashRunShare): void
  userMessage(
    sessionId: SessionId,
    text: string,
    images?: readonly ImageAttachment[]
  ): void
  /** Hands queued messages back the way a stop or a failed turn does. */
  flushQueue(sessionId: SessionId, messages: readonly QueuedMessage[]): void
  queueOf(sessionId: SessionId): QueueState | undefined
  text(sessionId: SessionId, delta: string): void
  thinking(sessionId: SessionId, delta: string): void
  toolCallStarted(sessionId: SessionId, callId: string, name: string): void
  /** Argument characters streamed so far, cumulative. */
  toolCallArgs(sessionId: SessionId, callId: string, chars: number): void
  toolStarted(sessionId: SessionId, callId: string, name: string, summary: string): void
  toolOutput(sessionId: SessionId, callId: string, chunk: string): void
  toolEnded(sessionId: SessionId, callId: string, ok: boolean, output: string): void
  endTurn(sessionId: SessionId): void
  failTurn(sessionId: SessionId, message: string): void
}

const NOW = '2026-08-19T14:14:00.000Z'

// A session in the sidebar is named by the titler, so the one a test drives
// carries a title too. A test about the untitled state passes `undefined`.
export const SESSION_TITLE = 'Wiring the composer to the agent port'

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

  // An absent image list is an absent argument, so a recorded call reads as
  // what was asked for.
  function argsOf(
    sessionId: SessionId,
    text: string,
    images?: readonly ImageAttachment[]
  ): readonly unknown[] {
    return images === undefined ? [sessionId, text] : [sessionId, text, images]
  }

  function queueOf(sessionId: SessionId): QueueState {
    const session = snapshot.sessions.find((candidate) => candidate.id === sessionId)
    return session?.queue ?? { steering: [], followUp: [] }
  }

  function panelOf(sessionId: SessionId): PanelState | undefined {
    return snapshot.sessions.find((candidate) => candidate.id === sessionId)?.panel
  }

  // Absent rather than empty, exactly as main folds it: an empty panel is no
  // panel at all.
  function setPanel(sessionId: SessionId, tabs: readonly PanelTab[], activeTabId: TabId): void {
    changeSession(sessionId, (session) => {
      const rest: SessionState = { ...session }
      delete (rest as { panel?: PanelState }).panel
      return tabs.length === 0 ? rest : { ...rest, panel: { tabs, activeTabId } }
    })
  }

  // Absent rather than empty, exactly as main folds it: an empty line is no
  // line at all, which is what makes the dock vanish.
  function setLine(sessionId: SessionId, line: QuestionLine): void {
    changeSession(sessionId, (session) => {
      const rest: SessionState = { ...session }
      delete (rest as { questions?: QuestionLine }).questions
      return line.open.length === 0 ? rest : { ...rest, questions: line }
    })
  }

  function setQueue(sessionId: SessionId, state: QueueState): void {
    // Absent rather than empty, exactly as main reports it.
    const empty = state.steering.length + state.followUp.length === 0
    changeSession(sessionId, (session) => {
      const rest: SessionState = { ...session }
      delete (rest as { queue?: QueueState }).queue
      return empty ? rest : { ...rest, queue: state }
    })
  }

  function queue(
    sessionId: SessionId,
    kind: QueuedKind,
    text: string,
    images?: readonly ImageAttachment[],
    // Present only for a message Crucible sent itself, which is what makes it
    // a card in the transcript and Crucible's own row in the queued strip.
    card?: SystemCard
  ): Promise<void> {
    const carried = images === undefined || images.length === 0 ? {} : { images }
    if (!turns.has(sessionId)) {
      // Nothing to queue into: main sends the text as the next prompt and
      // announces it, images and all, because no caller echoed it.
      const turnId = `t-${(minted += 1)}`
      turns.set(sessionId, turnId)
      changeSession(sessionId, (session) => ({ ...session, working: true, fresh: false }))
      emit({ type: 'turn_started', sessionId, turnId })
      emit({
        type: 'user_message',
        sessionId,
        turnId,
        text,
        ...carried,
        ...(card === undefined ? {} : { card })
      })
      emitState()
      return Promise.resolve()
    }
    const entry: QueuedEntry = { text, ...carried, ...(card === undefined ? {} : { origin: 'system' as const }) }
    const current = queueOf(sessionId)
    setQueue(
      sessionId,
      kind === 'steering'
        ? { ...current, steering: [...current.steering, entry] }
        : { ...current, followUp: [...current.followUp, entry] }
    )
    emitState()
    return Promise.resolve()
  }

  /** The tree scripted for a session, or the empty one a fresh session has. */
  function treeOf(id: SessionId): SessionTree {
    return port.trees.get(id) ?? { roots: [], path: [] }
  }

  /** What a jump that genuinely happened answers with. */
  function jumped(): { cancelled: boolean; editorText?: string } {
    return port.jumpText === undefined
      ? { cancelled: false }
      : { cancelled: false, editorText: port.jumpText }
  }

  let heldShare: ((outcome: 'delivered' | 'dropped') => void) | undefined
  /** Replies waiting for the line to empty, exactly as main holds them. */
  const held: AnsweredQuestion[] = []
  const heldJumps: {
    resolve: (outcome: { cancelled: boolean; editorText?: string }) => void
    reject: (cause: Error) => void
  }[] = []
  const heldTrees = new Map<SessionId, (tree: SessionTree) => void>()
  let heldWorktree: (() => void) | undefined
  let login: { resolve: () => void; reject: (cause: Error) => void } | undefined

  const port: ScriptedPort = {
    calls,
    models: [],
    history: [],
    providers: [],
    usage: new Map(),
    transcripts: new Map(),
    trees: new Map(),
    exhibits: new Map(),
    folder: null,
    shareOutcome: 'delivered',

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

    createSession(
      workspaceId: WorkspaceId,
      options?: { readonly issue?: string }
    ): Promise<SessionId> {
      // The options are recorded only where they were given, so an ordinary
      // New session reads as the one-argument call it is.
      calls.push({
        op: 'createSession',
        args: options === undefined ? [workspaceId] : [workspaceId, options]
      })
      if (port.createSessionRefusal !== undefined) {
        return Promise.reject(new Error(port.createSessionRefusal))
      }
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
            // One click of New session lands on the checkout, with the choice
            // still open.
            fresh: true,
            ...(options?.issue === undefined ? {} : { issue: options.issue }),
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
      // A session carries its workspace with it, exactly as main's store does:
      // landing on a session in another workspace switches to that workspace
      // rather than leaving the rail contradicting itself.
      const landed = snapshot.sessions.find((session) => session.id === id)
      snapshot = {
        ...snapshot,
        activeSessionId: id,
        ...(landed === undefined ? {} : { activeWorkspaceId: landed.workspaceId })
      }
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
      // The identity keeps its worktree and gets its choice back, exactly as
      // main resets one — and a fresh conversation never inherits a ghost
      // panel, so the tabs go with the old one.
      changeSession(id, (session) => {
        const reset: SessionState = { ...session, usage: undefined, fresh: true }
        delete (reset as { panel?: PanelState }).panel
        return reset
      })
      emitState()
      return Promise.resolve()
    },

    // Refused for a session that is not fresh, because the shell's guard is
    // the contract and the chip is only its presentation.
    setWorktree(sessionId: SessionId, worktree?: SessionWorktree): Promise<void> {
      calls.push({
        op: 'setWorktree',
        args: worktree === undefined ? [sessionId] : [sessionId, worktree]
      })
      if (port.worktreeRefusal !== undefined) {
        return Promise.reject(new Error(port.worktreeRefusal))
      }
      const found = snapshot.sessions.find((candidate) => candidate.id === sessionId)
      if (found === undefined) {
        return Promise.reject(new Error('That session is no longer open.'))
      }
      if (!found.fresh) {
        return Promise.reject(
          new Error('That session has already started. Reset it to change where it works.')
        )
      }
      // Nothing is said until the change has landed, which is what makes the
      // held case and the instant one behave the same way.
      const land = (): void => {
        changeSession(sessionId, (session) => {
          const rest: SessionState = { ...session }
          delete (rest as { worktree?: SessionWorktree }).worktree
          return worktree === undefined ? rest : { ...rest, worktree }
        })
        emitState()
      }
      if (port.holdWorktree !== true) {
        land()
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        heldWorktree = () => {
          land()
          resolve()
        }
      })
    },

    settleWorktreeChange(): void {
      const settle = heldWorktree
      heldWorktree = undefined
      settle?.()
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
        // A resumed conversation is not fresh and starts on the checkout.
        sessions: [
          ...snapshot.sessions,
          {
            id,
            workspaceId,
            createdAt: NOW,
            working: false,
            fresh: false,
            model: port.models[0]?.id
          }
        ],
        activeSessionId: id
      }
      emitState()
      return Promise.resolve(id)
    },

    sessionTree(id: SessionId): Promise<SessionTree> {
      if (port.holdTree !== true) return record('sessionTree', [id], treeOf(id))
      calls.push({ op: 'sessionTree', args: [id] })
      return new Promise<SessionTree>((resolve) => {
        heldTrees.set(id, resolve)
      })
    },

    settleTree(id: SessionId): void {
      const waiting = heldTrees.get(id)
      heldTrees.delete(id)
      waiting?.(treeOf(id))
    },

    jump(id: SessionId, ref: string, options: { readonly summarize: boolean }) {
      calls.push({ op: 'jump', args: [id, ref, options] })
      if (port.holdJump === true) {
        return new Promise<{ cancelled: boolean; editorText?: string }>((resolve, reject) => {
          heldJumps.push({ resolve, reject })
        })
      }
      if (port.jumpRefusal !== undefined) return Promise.reject(new Error(port.jumpRefusal))
      if (port.jumpCancelled === true) return Promise.resolve({ cancelled: true })
      return Promise.resolve(jumped())
    },

    settleJump(outcome): void {
      const held = heldJumps.shift()
      if (held === undefined) return
      if (outcome === 'jumped') held.resolve(jumped())
      else if (outcome === 'cancelled') held.resolve({ cancelled: true })
      else held.reject(new Error(outcome.failure))
    },

    summarizeRetry(sessionId, retry): void {
      emit({
        type: 'summarize_retry',
        sessionId,
        attempt: retry.attempt,
        maxAttempts: retry.maxAttempts,
        delayMs: retry.delayMs ?? 2000,
        message: retry.message
      })
    },

    setLabel(id: SessionId, ref: string, label?: string): Promise<void> {
      calls.push({ op: 'setLabel', args: [id, ref, label] })
      const tree = port.trees.get(id)
      if (tree !== undefined) port.trees.set(id, relabel(tree, ref, label))
      return Promise.resolve()
    },

    shareBashRun(sessionId: SessionId, run: BashRunShare): Promise<'delivered' | 'dropped'> {
      calls.push({ op: 'shareBashRun', args: [sessionId, run] })
      if (port.holdShare !== true) return Promise.resolve(port.shareOutcome)
      return new Promise((resolve) => {
        heldShare = resolve
      })
    },

    settleShare(outcome): void {
      const settle = heldShare
      heldShare = undefined
      settle?.(outcome)
    },

    listModels: () => record('listModels', [], port.models),

    listProviders: () => record('listProviders', [], port.providers),

    // Held open until the test settles it, which is what a login is: a flow
    // that runs while its questions are answered.
    login(providerId: string, method: AuthMethod): Promise<void> {
      calls.push({ op: 'login', args: [providerId, method] })
      if (login !== undefined) {
        return Promise.reject(
          new Error('A login is already under way. Finish or cancel it first.')
        )
      }
      return new Promise<void>((resolve, reject) => {
        login = { resolve, reject }
      })
    },

    answerAuthPrompt(promptId: string, value: string): Promise<void> {
      calls.push({ op: 'answerAuthPrompt', args: [promptId, value] })
      return Promise.resolve()
    },

    cancelLogin(): Promise<void> {
      calls.push({ op: 'cancelLogin', args: [] })
      const live = login
      login = undefined
      live?.reject(new Error('That login was cancelled.'))
      return Promise.resolve()
    },

    logout(providerId: string): Promise<void> {
      calls.push({ op: 'logout', args: [providerId] })
      return Promise.resolve()
    },

    sessionUsage: (id: SessionId) =>
      record('sessionUsage', [id], port.usage.get(id)),

    loginLive: () => login !== undefined,

    finishLogin(outcome): void {
      const live = login
      login = undefined
      if (live === undefined) return
      if (outcome === 'succeeded') live.resolve()
      else live.reject(new Error(outcome.failure))
    },

    authPrompt(prompt): void {
      emit({ type: 'auth_prompt', ...prompt })
    },

    closeAuthPrompt(promptId): void {
      emit({ type: 'auth_prompt_closed', promptId })
    },

    authNotice(notice): void {
      emit({ type: 'auth_notice', notice })
    },

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

    prompt(
      sessionId: SessionId,
      text: string,
      images?: readonly ImageAttachment[],
      options?: PromptOptions
    ): Promise<TurnId> {
      // Recorded as the IPC client sends it, so a test reads the same call.
      const args =
        options?.expiryAcknowledged === true
          ? [sessionId, text, images ?? [], options]
          : argsOf(sessionId, text, images)
      calls.push({ op: 'prompt', args })
      const turnId = `t-${(minted += 1)}`
      turns.set(sessionId, turnId)
      // The first accepted message is what ends freshness, exactly as the
      // shell ends it.
      changeSession(sessionId, (session) => ({ ...session, working: true, fresh: false }))
      emit({ type: 'turn_started', sessionId, turnId })
      emitState()
      return Promise.resolve(turnId)
    },

    // Queued while the session works, exactly as main answers; with no live
    // turn the text starts one, which is main's fallback.
    steer(
      sessionId: SessionId,
      text: string,
      images?: readonly ImageAttachment[]
    ): Promise<void> {
      calls.push({ op: 'steer', args: argsOf(sessionId, text, images) })
      return queue(sessionId, 'steering', text, images)
    },

    followUp(
      sessionId: SessionId,
      text: string,
      images?: readonly ImageAttachment[]
    ): Promise<void> {
      calls.push({ op: 'followUp', args: argsOf(sessionId, text, images) })
      return queue(sessionId, 'followUp', text, images)
    },

    dequeue(
      sessionId: SessionId,
      kind: QueuedKind,
      text: string
    ): Promise<QueuedEntry | undefined> {
      calls.push({ op: 'dequeue', args: [sessionId, kind, text] })
      if (port.dequeueMisses === true) return Promise.resolve(undefined)
      const current = queueOf(sessionId)
      const entries = [...(kind === 'steering' ? current.steering : current.followUp)]
      const at = entries.findIndex((entry) => entry.text === text)
      if (at === -1) return Promise.resolve(undefined)
      const [removed] = entries.splice(at, 1)
      setQueue(sessionId, kind === 'steering' ? { ...current, steering: entries } : { ...current, followUp: entries })
      emitState()
      return Promise.resolve(removed)
    },

    activateTab(sessionId: SessionId, tabId: TabId): Promise<void> {
      calls.push({ op: 'activateTab', args: [sessionId, tabId] })
      const panel = panelOf(sessionId)
      // An unknown id is a no-op above the port too: the agent may have closed
      // that tab while the click was in flight.
      if (panel === undefined || !panel.tabs.some((tab) => tab.id === tabId)) {
        return Promise.resolve()
      }
      setPanel(sessionId, panel.tabs, tabId)
      emitState()
      return Promise.resolve()
    },

    closeTab(sessionId: SessionId, tabId: TabId): Promise<void> {
      calls.push({ op: 'closeTab', args: [sessionId, tabId] })
      const panel = panelOf(sessionId)
      if (panel === undefined || !panel.tabs.some((tab) => tab.id === tabId)) {
        return Promise.resolve()
      }
      const tabs = panel.tabs.filter((tab) => tab.id !== tabId)
      // The last remaining tab takes over, which is where the model puts it.
      const active = tabs.some((tab) => tab.id === panel.activeTabId)
        ? panel.activeTabId
        : (tabs.at(-1)?.id ?? '')
      setPanel(sessionId, tabs, active)
      emitState()
      return Promise.resolve()
    },

    exhibit(sessionId: SessionId, tabId: TabId): Promise<{ readonly body: string }> {
      calls.push({ op: 'exhibit', args: [sessionId, tabId] })
      if (port.exhibitRefusal !== undefined) {
        return Promise.reject(new Error(port.exhibitRefusal))
      }
      return Promise.resolve({ body: port.exhibits.get(tabId) ?? '' })
    },

    showTab(sessionId: SessionId, tab: PanelTab): void {
      const panel = panelOf(sessionId)
      const tabs = panel?.tabs ?? []
      // Keyed by id: a re-show refreshes the tab in place and mints no second
      // one, which is what the model does with a path it has seen.
      const already = tabs.some((open) => open.id === tab.id)
      setPanel(
        sessionId,
        already ? tabs.map((open) => (open.id === tab.id ? tab : open)) : [...tabs, tab],
        tab.id
      )
      emitState()
      emit({ type: 'panel_shown', sessionId, tabId: tab.id })
    },

    panelOf,

    askQuestion(sessionId: SessionId, question: Question): void {
      const line = port.questionsOf(sessionId) ?? { open: [], held: 0 }
      setLine(sessionId, { open: [...line.open, question], held: line.held })
      emitState()
      emit({ type: 'question_asked', sessionId, questionId: question.id })
    },

    questionsOf: (sessionId) =>
      snapshot.sessions.find((candidate) => candidate.id === sessionId)?.questions,

    // Main's own rule, so a test drives the whole loop: the reply is held
    // beside the others, and only the one that empties the line sends the
    // batch — as a steering message, or as the next prompt when nothing is
    // working.
    replyToQuestion(
      sessionId: SessionId,
      questionId: QuestionId,
      reply: QuestionReply
    ): Promise<void> {
      calls.push({ op: 'replyToQuestion', args: [sessionId, questionId, reply] })
      const line = port.questionsOf(sessionId)
      const answered = line?.open.find((question) => question.id === questionId)
      if (line === undefined || answered === undefined) return Promise.resolve()
      const open = line.open.filter((question) => question.id !== questionId)
      held.push({ question: answered, reply })
      setLine(sessionId, { open, held: line.held + 1 })
      emitState()
      if (open.length > 0) return Promise.resolve()
      const batch = composeAnswerBatch([...held])
      held.length = 0
      const carried = batch.card
      return queue(sessionId, 'steering', batch.text, undefined, carried)
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

    bashRunShared(sessionId, run) {
      emit({
        type: 'bash_run_shared',
        sessionId,
        turnId: turns.get(sessionId) ?? 't-shared',
        command: run.command,
        output: run.output,
        ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode })
      })
    },

    userMessage(sessionId, text, images) {
      emit({
        type: 'user_message',
        sessionId,
        turnId: turn(sessionId),
        text,
        ...(images === undefined ? {} : { images })
      })
    },

    flushQueue(sessionId, messages) {
      setQueue(sessionId, { steering: [], followUp: [] })
      emit({ type: 'queue_flushed', sessionId, messages })
      emitState()
    },

    queueOf: (sessionId) =>
      snapshot.sessions.find((session) => session.id === sessionId)?.queue,

    text(sessionId, delta) {
      emit({ type: 'text_delta', sessionId, turnId: turn(sessionId), delta })
    },

    thinking(sessionId, delta) {
      emit({ type: 'thinking_delta', sessionId, turnId: turn(sessionId), delta })
    },

    toolCallStarted(sessionId, callId, name) {
      emit({ type: 'tool_call_started', sessionId, turnId: turn(sessionId), callId, name })
    },

    toolCallArgs(sessionId, callId, chars) {
      emit({ type: 'tool_call_args', sessionId, turnId: turn(sessionId), callId, chars })
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
    sessions: [
      {
        id: 's1',
        workspaceId: 'w1',
        createdAt: NOW,
        title: SESSION_TITLE,
        working: false,
        fresh: false,
        ...overrides
      }
    ],
    activeSessionId: 's1'
  }
}

/** A label change the way an adapter applies one: the tree is read back. */
function relabel(tree: SessionTree, ref: string, label?: string): SessionTree {
  function walk(nodes: readonly TreeNode[]): TreeNode[] {
    return nodes.map((node) => {
      const children = walk(node.children)
      if (node.ref !== ref) return { ...node, children }
      // Rebuilt rather than spread, so a cleared label is genuinely absent.
      return {
        ref: node.ref,
        text: node.text,
        at: node.at,
        ...(label === undefined || label === '' ? {} : { label }),
        ...(node.activity === undefined ? {} : { activity: node.activity }),
        children
      }
    })
  }
  return { ...tree, roots: walk(tree.roots) }
}
