import { homedir } from 'node:os'
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Provider,
  ThinkingLevel as SdkThinkingLevel
} from '@earendil-works/pi-ai'
import type {
  AgentSession,
  CreateAgentSessionOptions,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SessionTreeNode,
  SettingsManager,
  ToolDefinition
} from '@earendil-works/pi-coding-agent'
import type {
  AdapterEvent,
  AdapterEventListener,
  BindRequest,
  Binding,
  ConversationAdapter,
  ResumeRequest,
  UsageRequest
} from '../../shared/agent/adapter'
import type {
  AuthMethod,
  AuthNotice,
  AuthPromptKind,
  BashRunShare,
  HistoryMatch,
  ImageAttachment,
  ModelId,
  ModelInfo,
  ProviderState,
  QueuedKind,
  QueuedMessage,
  SessionId,
  SessionTree,
  SessionUsage,
  ThinkingLevel,
  TranscriptItem,
  TreeNode,
  TurnId,
  Unsubscribe
} from '../../shared/agent/port'
// Spelled with their extensions so plain Node can load this module too: its
// ESM resolver does no extension guessing.
import { summarizeActivity } from '../../shared/agent/activity.ts'
import { TITLE_MODEL } from '../../shared/agent/known-models.ts'
import { PANEL_TOOLS, type PanelTools } from '../../shared/agent/panel-tools.ts'
import { RUN_TOOLS, type RunTools } from '../../shared/agent/run-tools.ts'
import { displaySafeMessage } from './adapter-error.ts'
import { toProviderState, type AuthFacts, type ProviderFacts } from './providers.ts'
import { crucibleAgentDir, workspaceSessionDir } from './paths.ts'
import { createEventMapper } from './sdk-events.ts'
import { sanitizeTitle, TITLE_INSTRUCTION, titleInput } from './sdk-titler.ts'
import {
  BASH_RUN_TYPE,
  deliveredBashRunId,
  toTranscript,
  userTextOf,
  type StoredMessage
} from './sdk-transcript.ts'
import { sumUsage, type StoredUsage } from './usage.ts'

// Imported dynamically because the SDK is ESM-only, so the CommonJS main
// bundle cannot `require` it and a fake-flavor launch never loads it.
type Sdk = typeof import('@earendil-works/pi-coding-agent')

interface Bound {
  session: AgentSession
  readonly workspacePath: string
  token: string
  running?: RunningTurn
  /** Bash runs waiting for the boundary that delivers them, oldest first. */
  readonly shares: PendingShare[]
  /** The last numbers reported for this conversation, so a still count is not re-sent. */
  reported?: ReportedUsage
  /**
   * A prompt sent to π but not yet in `session.messages`, which is the whole
   * first minutes of a session as far as the titler can see.
   */
  asked?: string
}

interface ReportedUsage {
  readonly usedTokens: number
  readonly contextWindow: number
  readonly cost?: number
}

interface PendingShare {
  readonly run: BashRunShare
  readonly settle: (outcome: 'delivered' | 'dropped') => void
}

interface RunningTurn {
  cancel(): void
  /** Abandon it with its document: the turn says nothing more at all. */
  abandon(): void
}

// A login π is running for us: its questions are out as port events and their
// answers come back by promptId.
interface LiveLogin {
  readonly abort: AbortController
  readonly waiting: Map<string, (answer: { value: string } | { closed: string }) => void>
}

const HISTORY_LIMIT = 50

const PREVIEW_LIMIT = 140

export function createSdkAdapter({
  panel,
  runs,
  systemPrompt,
  openExternal
}: {
  // The same model the fake's scripts call and the same model the shell reads:
  // the tools registered below are its three behaviors and nothing more.
  readonly panel: PanelTools
  // The workflow-run behaviors, mounted as custom tools on every composed
  // agent (Q19: tools, not a bash CLI). Absent — as in `prove:sdk` — means no
  // run tools are mounted.
  readonly runs?: RunTools
  // Passed as a full override: every session this adapter opens is told this
  // and nothing π wrote.
  readonly systemPrompt: string
  // Opening the OS browser is main's to do, and it is injected rather than
  // imported so this module still loads under plain Node for `prove:sdk`.
  readonly openExternal?: (url: string) => void
}): ConversationAdapter {
  const agentDir = crucibleAgentDir(homedir())
  const listeners = new Set<AdapterEventListener>()
  const sessions = new Map<SessionId, Bound>()
  const resources = new Map<string, Promise<WorkspaceResources>>()
  let sdkModule: Promise<Sdk> | undefined
  let modelRuntime: Promise<ModelRuntime> | undefined
  // One at a time: a second login while one is live is refused.
  let liveLogin: LiveLogin | undefined
  let prompts = 0

  interface WorkspaceResources {
    readonly resourceLoader: DefaultResourceLoader
    readonly settingsManager: SettingsManager
  }

  function emit(event: AdapterEvent): void {
    for (const listener of [...listeners]) listener(event)
  }

  function sdk(): Promise<Sdk> {
    sdkModule ??= import('@earendil-works/pi-coding-agent')
    return sdkModule
  }

  function runtime(): Promise<ModelRuntime> {
    modelRuntime ??= sdk().then((pi) => pi.ModelRuntime.create())
    return modelRuntime
  }

  function sessionDir(workspacePath: string): string {
    return workspaceSessionDir(agentDir, workspacePath)
  }

  // Stock π except for the emptied resources below, which keep the user's
  // globally configured extensions out of a Crucible session, and the system
  // prompt, which is Crucible's outright.
  function workspaceResources(workspacePath: string): Promise<WorkspaceResources> {
    const existing = resources.get(workspacePath)
    if (existing !== undefined) return existing

    const built = (async (): Promise<WorkspaceResources> => {
      const pi = await sdk()
      const settingsManager = pi.SettingsManager.create(workspacePath, agentDir)
      // In memory only, never written back to the user's settings files. The
      // queue modes are fixed here: a kind is delivered as one group.
      settingsManager.applyOverrides({
        packages: [],
        extensions: [],
        steeringMode: 'all',
        followUpMode: 'all'
      })
      const resourceLoader = new pi.DefaultResourceLoader({
        cwd: workspacePath,
        agentDir,
        settingsManager,
        noExtensions: true,
        // π's own prompt folders are not read at all: commands are Crucible's,
        // and two command systems in one composer would be two grammars.
        noPromptTemplates: true,
        // A skill is one of the few things that would still reach a session
        // past a full prompt override.
        noSkills: true,
        // The base is ignored, so π's own prompt never reaches a session and a
        // system-prompt file discovered in any folder is dead.
        systemPromptOverride: () => systemPrompt,
        // A Crucible-owned custom-instructions mechanism is deferred, so a file
        // dropped into the agent dir must not become one by accident.
        appendSystemPromptOverride: () => []
      })
      await resourceLoader.reload()
      return { resourceLoader, settingsManager }
    })()

    resources.set(workspacePath, built)
    return built
  }

  /** `provider/id`, which is the whole of what a `ModelId` is here. */
  function modelIdOf(model: { provider: string; id: string }): ModelId {
    return `${model.provider}/${model.id}`
  }

  async function resolveModel(id: ModelId): Promise<Parameters<AgentSession['setModel']>[0]> {
    const slash = id.indexOf('/')
    if (slash === -1) throw new Error('That model is not one Crucible can name.')
    const found = (await runtime()).getModel(id.slice(0, slash), id.slice(slash + 1))
    if (found === undefined) throw new Error('That model is not available with your credentials.')
    return found
  }

  // One set per session, because a tool call has to reach the panel model with
  // the identity and folder of the session it came from.
  function panelCustomTools(sessionId: SessionId, workspacePath: string): ToolDefinition[] {
    return PANEL_TOOLS.map((tool): ToolDefinition => {
      // Written out longhand so this module needs no schema library.
      const parameters = {
        type: 'object',
        required: tool.parameters.map((parameter) => parameter.name),
        properties: Object.fromEntries(
          tool.parameters.map((parameter) => [
            parameter.name,
            { type: 'string', description: parameter.description }
          ])
        )
      } as unknown as ToolDefinition['parameters']

      return {
        name: tool.name,
        label: tool.label,
        // A description survives the prompt override: it rides the request's
        // tools parameter.
        description: tool.description,
        parameters,
        // A model error propagates: π then reports a failed call carrying the
        // exact text the panel model built.
        async execute(_callId: string, params: unknown) {
          const given = (params ?? {}) as { path?: string; title?: string; id?: string }
          if (tool.name === 'panel_show') {
            return said(panel.show(sessionId, workspacePath, given.path ?? '', given.title ?? ''))
          }
          if (tool.name === 'panel_close') return said(panel.close(sessionId, given.id ?? ''))
          return said(panel.list(sessionId))
        }
      }
    })
  }

  // The run behaviors as π tools, one set per session: a call has to reach
  // the engine with the identity and working directory of the session it
  // came from, because that is where the default base commit is read.
  function runCustomTools(sessionId: SessionId, workspacePath: string): ToolDefinition[] {
    const behaviors = runs
    if (behaviors === undefined) return []
    return RUN_TOOLS.map((tool): ToolDefinition => {
      const parameters = {
        type: 'object',
        required: tool.parameters
          .filter((parameter) => parameter.optional !== true)
          .map((parameter) => parameter.name),
        properties: Object.fromEntries(
          tool.parameters.map((parameter) => [
            parameter.name,
            { type: 'string', description: parameter.description }
          ])
        )
      } as unknown as ToolDefinition['parameters']

      return {
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters,
        async execute(_callId: string, params: unknown) {
          const given = (params ?? {}) as {
            workflow?: string
            inputs?: string
            base?: string
            runId?: string
            message?: string
          }
          if (tool.name === 'crucible_workflows') {
            return said(await behaviors.workflows(workspacePath))
          }
          if (tool.name === 'crucible_run') {
            return said(
              await behaviors.start(
                sessionId,
                workspacePath,
                given.workflow ?? '',
                parseInputs(given.inputs),
                given.base
              )
            )
          }
          if (tool.name === 'crucible_answer') {
            return said(
              await behaviors.answer(sessionId, given.runId ?? '', given.message ?? '')
            )
          }
          return said(await behaviors.list(sessionId))
        }
      }
    })
  }

  async function open(
    sessionId: SessionId,
    workspacePath: string,
    sessionManager: SessionManager,
    preferred?: { model?: ModelId; thinkingLevel?: ThinkingLevel }
  ): Promise<AgentSession> {
    const pi = await sdk()
    const { resourceLoader, settingsManager } = await workspaceResources(workspacePath)

    const options: CreateAgentSessionOptions = {
      cwd: workspacePath,
      agentDir,
      sessionManager,
      settingsManager,
      resourceLoader,
      modelRuntime: await runtime(),
      customTools: [
        ...panelCustomTools(sessionId, workspacePath),
        ...runCustomTools(sessionId, workspacePath)
      ]
    }

    if (preferred?.model !== undefined) {
      // A preference the credentials cannot reach is not an error: the SDK's
      // own fallback answers, and that fallback is what gets reported back.
      try {
        options.model = await resolveModel(preferred.model)
      } catch {
        options.model = undefined
      }
    }
    if (preferred?.thinkingLevel !== undefined) {
      options.thinkingLevel = preferred.thinkingLevel as CreateAgentSessionOptions['thinkingLevel']
    }

    const { session } = await pi.createAgentSession(options)
    return session
  }

  function describe(bound: Bound, restored: boolean): Binding {
    const model = bound.session.model
    return {
      token: bound.token,
      model: model === undefined ? undefined : modelIdOf(model),
      thinkingLevel: bound.session.thinkingLevel,
      restored
    }
  }

  // The token is the session's own file, which is why it must never leave
  // this module as anything but an opaque string.
  function tokenOf(session: AgentSession): string {
    return session.sessionFile ?? session.sessionId
  }

  function requireBound(sessionId: SessionId): Bound {
    const bound = sessions.get(sessionId)
    if (bound === undefined) throw new Error('That session is not bound to a conversation.')
    return bound
  }

  // A run that never reached a delivery point stays local, and whoever is
  // holding its promise is told so rather than left waiting.
  function dropShares(bound: Bound): void {
    for (const share of bound.shares.splice(0, bound.shares.length)) share.settle('dropped')
  }

  // π's tree, read as Crucible's: user messages are the nodes, everything else
  // collapses into the dim line above the next one.
  function treeOf(sessionManager: SessionManager): SessionTree {
    function collect(subtrees: readonly SessionTreeNode[]): {
      nodes: TreeNode[]
      passed: TranscriptItem[]
    } {
      const nodes: TreeNode[] = []
      const passed: TranscriptItem[] = []

      for (const subtree of subtrees) {
        const below = collect(subtree.children)
        const { entry } = subtree
        const message =
          entry.type === 'message' && entry.message.role === 'user' ? entry.message : undefined

        if (message !== undefined) {
          const activity = summarizeActivity(below.passed)
          nodes.push({
            ref: entry.id,
            text: userTextOf(message.content),
            at: entry.timestamp,
            ...(subtree.label === undefined ? {} : { label: subtree.label }),
            ...(activity === undefined ? {} : { activity }),
            children: below.nodes
          })
          continue
        }

        // Not a node: it belongs to the line above it, and whatever nodes hang
        // below it belong to the level it was found at.
        passed.push(...toTranscript(entriesToMessages(entry)))
        passed.push(...below.passed)
        nodes.push(...below.nodes)
      }

      return { nodes, passed }
    }

    // Walked by parent link rather than trusted from a list, so the path is
    // the one π's own leaf pointer describes.
    const path: string[] = []
    let at = sessionManager.getLeafId()
    const guard = new Set<string>()
    while (at !== null && at !== undefined && !guard.has(at)) {
      guard.add(at)
      const entry = sessionManager.getEntry(at)
      if (entry === undefined) break
      if (entry.type === 'message' && entry.message.role === 'user') path.push(entry.id)
      at = entry.parentId
    }

    return { roots: collect(sessionManager.getTree()).nodes, path: path.reverse() }
  }

  // One entry's worth of message, if it carries one: the activity line counts
  // real entries and invents nothing.
  function entriesToMessages(entry: { type: string; message?: unknown }): StoredMessage[] {
    return entry.type === 'message' ? [entry.message as StoredMessage] : []
  }

  // `clearQueue()` removes and returns in one step, so nothing can be
  // delivered between reading the queue and emptying it.
  function flushQueue(bound: Bound, sessionId: SessionId): void {
    const { steering, followUp } = bound.session.clearQueue()
    const messages: QueuedMessage[] = [
      ...steering.map((text): QueuedMessage => ({ kind: 'steering', text })),
      ...followUp.map((text): QueuedMessage => ({ kind: 'followUp', text }))
    ]
    if (messages.length === 0) return
    emit({ type: 'queue_flushed', sessionId, messages })
  }

  // A typed prompt and a shared bash run differ only in what `deliver` sends,
  // never in how the turn is watched, stopped or ended.
  async function runTurn(
    sessionId: SessionId,
    turnId: TurnId,
    deliver: () => Promise<unknown>
  ): Promise<void> {
    const bound = requireBound(sessionId)
    const { session } = bound
    const mapper = createEventMapper()

    let cancelled = false
    let abandoned = false
    // A reported failure is remembered rather than emitted, because the SDK
    // retries transient ones behind this seam and only its last word counts.
    let outcome: AdapterEvent = { type: 'turn_ended', sessionId, turnId }

    emit({ type: 'turn_started', sessionId, turnId })

    const unsubscribe = session.subscribe((event) => {
      if (abandoned) return
      // π's own list has the prompt now, so the copy kept for the titler is
      // no longer the only record of it.
      if (event.type === 'message_start' && event.message.role === 'user') {
        bound.asked = undefined
      }
      const mapped = mapper.map(event, { sessionId, turnId })
      if (mapped?.type === 'turn_error') {
        outcome = mapped
      } else if (mapped !== undefined) {
        if (mapped.type === 'text_delta') {
          // Text arriving after a failed message is the SDK's own retry
          // succeeding: the turn is no longer failing.
          outcome = { type: 'turn_ended', sessionId, turnId }
        }
        emit(mapped)
      }

      // The three moments the context genuinely moved: an answer landed with
      // its own token count, a tool result was appended after it, or a
      // compaction threw most of the conversation away. Deltas are skipped
      // because a per-character re-estimate would say nothing new.
      if (
        event.type === 'message_end' ||
        event.type === 'tool_execution_end' ||
        event.type === 'compaction_end'
      ) {
        reportUsage(sessionId, bound)
      }
    })

    bound.running = {
      cancel(): void {
        cancelled = true
        // Aborting the run is what stops a paid request from streaming on
        // unseen.
        void session.abort()
      },
      abandon(): void {
        abandoned = true
        void session.abort()
      }
    }

    try {
      await deliver()
    } catch (cause) {
      outcome = {
        type: 'turn_error',
        sessionId,
        turnId,
        message: displaySafeMessage(cause)
      }
    } finally {
      unsubscribe()
      bound.running = undefined
    }

    if (abandoned) return

    // Anything still queued when a run is over was never delivered, so it goes
    // back to the composer rather than into the next run.
    flushQueue(bound, sessionId)
    dropShares(bound)

    // Decided here because only the adapter that called `abort()` knows an
    // abort happened.
    emit(cancelled ? { type: 'turn_cancelled', sessionId, turnId } : outcome)

    // The last word on the turn: the cost is only whole once the final message
    // has been written with its usage.
    reportUsage(sessionId, bound)
  }

  // π's `AuthInteraction` is an SDK type and cannot cross the port, so it is
  // translated here: questions leave as events, answers come back by promptId.
  function interactionFor(flow: LiveLogin): AuthInteraction {
    return {
      signal: flow.abort.signal,

      prompt(asked: AuthPrompt): Promise<string> {
        prompts += 1
        const promptId = `auth-${prompts}`
        return new Promise<string>((resolve, reject) => {
          flow.waiting.set(promptId, (answer) => {
            flow.waiting.delete(promptId)
            if ('value' in answer) resolve(answer.value)
            else reject(new Error(answer.closed))
          })
          // π aborts one prompt when the flow resolved it another way — the
          // browser callback beating the paste field.
          asked.signal?.addEventListener('abort', () => {
            const settle = flow.waiting.get(promptId)
            if (settle === undefined) return
            emit({ type: 'auth_prompt_closed', promptId })
            settle({ closed: 'That step was answered another way.' })
          })
          // A question carries either a placeholder or a list of options,
          // never both: which one is what π's own kinds differ by.
          const placeholder = 'placeholder' in asked ? asked.placeholder : undefined
          const options = 'options' in asked ? asked.options : undefined
          emit({
            type: 'auth_prompt',
            promptId,
            kind: promptKind(asked.type),
            message: asked.message,
            ...(placeholder === undefined ? {} : { placeholder }),
            ...(options === undefined
              ? {}
              : {
                  options: options.map((option) => ({
                    id: option.id,
                    label: option.label,
                    ...(option.description === undefined
                      ? {}
                      : { description: option.description })
                  }))
                })
          })
        })
      },

      notify(event: AuthEvent): void {
        const notice = toNotice(event)
        if (notice === undefined) return
        emit({ type: 'auth_notice', notice })
        // The renderer gets no open-external capability of its own, so the
        // browser is opened here, in main.
        if (notice.kind === 'auth-url') openExternal?.(notice.url)
      }
    }
  }

  /** Nothing may be left waiting on a flow that is over, however it ended. */
  function closePrompts(flow: LiveLogin, why: string): void {
    for (const [promptId, settle] of [...flow.waiting]) {
      emit({ type: 'auth_prompt_closed', promptId })
      settle({ closed: why })
    }
  }

  // π keeps no context counter: it recomputes the estimate from the branch on
  // every read, so this is worth asking for whenever the conversation grows —
  // on the bind, after each answer and tool result, and once the turn is over.
  function reportUsage(sessionId: SessionId, bound: Bound): void {
    const usage = bound.session.getContextUsage()
    // Nothing at all rather than a guess when π reports nothing: right after a
    // compaction it genuinely does not know yet.
    if (usage?.tokens == null) return

    // The tokens are the current path's, as π counts them; the cost beside
    // them is the whole conversation's, because money does not vanish on a
    // jump.
    const spent = usageOf(bound.session.sessionManager)
    const next: ReportedUsage = {
      usedTokens: usage.tokens,
      contextWindow: usage.contextWindow,
      ...(spent === undefined ? {} : { cost: spent.totalCost })
    }
    const last = bound.reported
    if (
      last !== undefined &&
      last.usedTokens === next.usedTokens &&
      last.contextWindow === next.contextWindow &&
      last.cost === next.cost
    ) {
      return
    }

    bound.reported = next
    emit({ type: 'usage', sessionId, ...next })
  }

  /** π's per-message usage over a whole conversation, every branch of it. */
  function usageOf(manager: SessionManager): SessionUsage | undefined {
    return sumUsage(
      manager.getEntries().map((entry) => {
        const carrier = entry as { message?: { usage?: StoredUsage }; usage?: StoredUsage }
        return carrier.message?.usage ?? carrier.usage
      })
    )
  }

  // Stop the work before letting go of the session, or an in-flight request
  // outlives the thing that could abort it.
  function close(session: AgentSession): void {
    void (async () => {
      try {
        await session.abort()
      } catch {
        // Nobody is left to tell: whoever owned this session has stopped
        // speaking for it.
      }
      try {
        session.dispose()
      } catch {
        // Nobody is left to tell here either.
      }
    })()
  }

  return {
    async bind(request: BindRequest): Promise<Binding> {
      const already = sessions.get(request.sessionId)
      if (already !== undefined) return describe(already, true)

      const pi = await sdk()
      let session: AgentSession | undefined
      let restored = false

      if (request.token !== undefined) {
        try {
          // No preference is passed: the session's own file already carries
          // the model and thinking level it was left on.
          session = await open(
            request.sessionId,
            request.workspacePath,
            pi.SessionManager.open(
              request.token,
              sessionDir(request.workspacePath),
              request.workspacePath
            )
          )
          restored = true
        } catch {
          // The conversation is gone, so a fresh one is bound instead and the
          // caller is told nothing was restored.
          session = undefined
        }
      }

      session ??= await open(
        request.sessionId,
        request.workspacePath,
        pi.SessionManager.create(request.workspacePath, sessionDir(request.workspacePath)),
        {
          model: request.preferredModel,
          thinkingLevel: request.preferredThinkingLevel
        }
      )

      const bound: Bound = {
        session,
        workspacePath: request.workspacePath,
        token: tokenOf(session),
        shares: []
      }
      sessions.set(request.sessionId, bound)
      // A conversation that came back is already holding context, and it is
      // holding it before anyone prompts it again: without this the meter
      // reads as a dash from launch until the next turn ends. A fresh
      // conversation says nothing, so nothing is reported for one.
      if (restored) reportUsage(request.sessionId, bound)
      return describe(bound, restored)
    },

    async reset(sessionId: SessionId): Promise<Binding> {
      const bound = requireBound(sessionId)
      const pi = await sdk()
      const previous = bound.session

      // The old conversation is detached, not deleted: its file stays where π
      // put it and stays findable through history search.
      bound.running?.abandon()
      close(previous)

      const session = await open(
        sessionId,
        bound.workspacePath,
        pi.SessionManager.create(bound.workspacePath, sessionDir(bound.workspacePath)),
        {
          model: previous.model === undefined ? undefined : modelIdOf(previous.model),
          thinkingLevel: previous.thinkingLevel
        }
      )
      bound.session = session
      bound.token = tokenOf(session)
      // The old conversation's numbers described a conversation this session
      // no longer has.
      bound.reported = undefined
      return describe(bound, false)
    },

    async resume(request: ResumeRequest): Promise<Binding> {
      const pi = await sdk()
      const existing = sessions.get(request.sessionId)
      if (existing !== undefined) {
        existing.running?.abandon()
        close(existing.session)
      }

      const session = await open(
        request.sessionId,
        request.workspacePath,
        pi.SessionManager.open(request.ref, sessionDir(request.workspacePath), request.workspacePath)
      )
      const bound: Bound = {
        session,
        workspacePath: request.workspacePath,
        token: tokenOf(session),
        shares: []
      }
      sessions.set(request.sessionId, bound)
      reportUsage(request.sessionId, bound)
      return describe(bound, true)
    },

    async transcript(sessionId: SessionId): Promise<readonly TranscriptItem[]> {
      return toTranscript(requireBound(sessionId).session.messages)
    },

    release(sessionId: SessionId): void {
      const bound = sessions.get(sessionId)
      if (bound === undefined) return
      bound.running?.abandon()
      dropShares(bound)
      // The session object is let go; its file is not touched. Removal forgets
      // a sidebar entry and nothing else.
      close(bound.session)
      sessions.delete(sessionId)
    },

    async searchHistory(workspacePath: string, query: string): Promise<readonly HistoryMatch[]> {
      const pi = await sdk()
      const wanted = query.trim().toLowerCase()
      // Only Crucible's own folder: a conversation from before the move keeps
      // opening by path and stops appearing in this search.
      const found = await pi.SessionManager.list(workspacePath, sessionDir(workspacePath))

      return found
        .filter((info) => info.messageCount > 0)
        .filter(
          (info) =>
            wanted === '' ||
            (info.name ?? '').toLowerCase().includes(wanted) ||
            info.firstMessage.toLowerCase().includes(wanted) ||
            info.allMessagesText.toLowerCase().includes(wanted)
        )
        .sort((left, right) => right.modified.getTime() - left.modified.getTime())
        .slice(0, HISTORY_LIMIT)
        .map((info) => ({
          // A file path, so it stays opaque above this module; the preview is
          // the part meant to be shown.
          ref: info.path,
          preview: preview(info.name ?? info.firstMessage),
          at: info.modified.toISOString()
        }))
    },

    sameConversation(token: string, ref: string): boolean {
      return token === ref
    },

    // π's own tree, read through π's own API: no session file is opened, parsed
    // or written here.
    async sessionTree(sessionId: SessionId): Promise<SessionTree> {
      return treeOf(requireBound(sessionId).session.sessionManager)
    },

    // In place, in the same session file: π moves the leaf and keeps every
    // abandoned entry exactly where it is.
    async jump(
      sessionId: SessionId,
      ref: string,
      summarize: boolean
    ): Promise<{ editorText?: string }> {
      const bound = requireBound(sessionId)
      const navigated = await bound.session.navigateTree(ref, { summarize })
      if (navigated.cancelled) throw new Error('That jump did not happen.')
      // The branch under the session changed, so whatever was last reported
      // counted messages that are no longer on the path.
      bound.reported = undefined
      return navigated.editorText === undefined ? {} : { editorText: navigated.editorText }
    },

    // Labels live with the conversation, which is π's own label API and not a
    // store of Crucible's.
    async setLabel(sessionId: SessionId, ref: string, label?: string): Promise<void> {
      const trimmed = label === undefined || label.trim() === '' ? undefined : label.trim()
      requireBound(sessionId).session.sessionManager.appendLabelChange(ref, trimmed)
    },

    async listModels(): Promise<readonly ModelInfo[]> {
      const [pi, available] = await Promise.all([
        import('@earendil-works/pi-ai'),
        runtime().then((models) => models.getAvailable())
      ])
      return available
        .map((model) => ({
          id: modelIdOf(model),
          label: model.name,
          // Whatever the SDK reports for this model: no level names are
          // hard-coded anywhere in Crucible.
          thinkingLevels: pi.getSupportedThinkingLevels(model) as readonly ThinkingLevel[]
        }))
        .sort((left, right) => left.label.localeCompare(right.label))
    },

    // The level the session is on afterwards is π's answer, not Crucible's:
    // the new model may not support the level the old one was on.
    async setModel(
      sessionId: SessionId,
      model: ModelId
    ): Promise<{ thinkingLevel?: ThinkingLevel }> {
      const { session } = requireBound(sessionId)
      await session.setModel(await resolveModel(model))
      return { thinkingLevel: session.thinkingLevel }
    },

    // One non-streaming completion, and a model call rather than an agent
    // Crucible starts: no role prompt, no standing prompt, no tools.
    async titleConversation(sessionId: SessionId): Promise<
      | { title: string; spend?: { tokens: number; cost: number } }
      | undefined
    > {
      const bound = requireBound(sessionId)
      const { session } = bound
      const input = titleInput(toTranscript(session.messages), bound.asked)
      if (input === undefined) return undefined

      const [pi, models, model] = await Promise.all([
        import('@earendil-works/pi-ai'),
        runtime(),
        resolveModel(TITLE_MODEL)
      ])
      // π's own name for "no thinking" is read back from π, so no level name
      // is written here.
      const levels = pi.getSupportedThinkingLevels(model)
      const noThinking = pi.getSupportedThinkingLevels({ ...model, reasoning: false })[0]
      const lowest = levels[0]
      // π asks for no thinking by carrying no level at all, which is exactly
      // what the first position means when it is that marker.
      const reasoning =
        lowest === undefined || lowest === noThinking
          ? undefined
          : (lowest as SdkThinkingLevel)

      const answer = await models.completeSimple(
        model,
        {
          systemPrompt: TITLE_INSTRUCTION,
          messages: [{ role: 'user', content: input, timestamp: Date.now() }]
        },
        reasoning === undefined ? undefined : { reasoning }
      )
      const title = sanitizeTitle(pi.contentText(answer.content))
      // An empty answer is a failed pass: the last good title stays.
      if (title === undefined) throw new Error('The titler answered with nothing.')
      const usage = answer.usage
      return usage === undefined
        ? { title }
        : { title, spend: { tokens: usage.totalTokens, cost: usage.cost.total } }
    },

    async setThinkingLevel(sessionId: SessionId, level: ThinkingLevel): Promise<void> {
      requireBound(sessionId).session.setThinkingLevel(
        level as Parameters<AgentSession['setThinkingLevel']>[0]
      )
    },

    // π's whole catalog, unfiltered: which providers become a list and which a
    // picker is the settings surface's question, not this seam's.
    async listProviders(): Promise<readonly ProviderState[]> {
      const models = await runtime()
      return Promise.all(
        models.getProviders().map(async (provider) => {
          // A provider whose check fails is reported as having no credential
          // rather than taking the whole list down with it.
          const check = await models
            .checkAuth(provider.id)
            .catch(() => undefined)
          return toProviderState(
            facts(provider),
            check === undefined
              ? undefined
              : ({ type: check.type, source: check.source } as AuthFacts)
          )
        })
      )
    },

    // π owns the flow, the token exchange and the storage; Crucible renders it.
    async login(providerId: string, method: AuthMethod): Promise<void> {
      if (liveLogin !== undefined) {
        throw new Error('A login is already under way. Finish or cancel it first.')
      }
      const flow: LiveLogin = { abort: new AbortController(), waiting: new Map() }
      liveLogin = flow
      try {
        const models = await runtime()
        await models.login(
          providerId,
          method === 'oauth' ? 'oauth' : 'api_key',
          interactionFor(flow)
        )
      } catch (cause) {
        // Including π's `CredentialSynchronizationError`: the sentence is
        // display-safe and the detail goes to the run log through the shell.
        throw new Error(displaySafeMessage(cause, 'That login did not finish.'), { cause })
      } finally {
        closePrompts(flow, 'That login is over.')
        liveLogin = undefined
      }
    },

    // A stale answer names a prompt nobody is waiting on any more, which is a
    // no-op rather than an error.
    async answerAuthPrompt(promptId: string, value: string): Promise<void> {
      liveLogin?.waiting.get(promptId)?.({ value })
    },

    async cancelLogin(): Promise<void> {
      const flow = liveLogin
      if (flow === undefined) return
      closePrompts(flow, 'That login was cancelled.')
      flow.abort.abort()
    },

    async logout(providerId: string): Promise<void> {
      try {
        await (await runtime()).logout(providerId)
      } catch (cause) {
        throw new Error(displaySafeMessage(cause, 'That logout did not finish.'), { cause })
      }
    },

    // Works for any curated session of the workspace, bound or not: an unbound
    // one is read from its own token, which stays opaque above this module.
    async sessionUsage(request: UsageRequest): Promise<SessionUsage | undefined> {
      const bound = sessions.get(request.sessionId)
      if (bound !== undefined) return usageOf(bound.session.sessionManager)
      if (request.token === undefined) return undefined
      const pi = await sdk()
      try {
        return usageOf(
          pi.SessionManager.open(
            request.token,
            sessionDir(request.workspacePath),
            request.workspacePath
          )
        )
      } catch {
        // The conversation is gone; a session with no numbers shows dashes.
        return undefined
      }
    },

    prompt(
      sessionId: SessionId,
      turnId: TurnId,
      text: string,
      images?: readonly ImageAttachment[]
    ): Promise<void> {
      const bound = requireBound(sessionId)
      const { session } = bound
      const options =
        images === undefined || images.length === 0
          ? undefined
          : { images: images.map(toImageContent) }
      // Held from before the turn is announced, because the shell asks for a
      // title the moment it hears the start and π appends the prompt to its
      // own list some way into the call below.
      bound.asked = text
      return runTurn(sessionId, turnId, () => session.prompt(text, options)).finally(() => {
        bound.asked = undefined
      })
    },

    // The idle path: a turn whose content is the run itself, written in the
    // same wire format a delivered share uses.
    promptBashRun(sessionId: SessionId, turnId: TurnId, run: BashRunShare): Promise<void> {
      const { session } = requireBound(sessionId)
      return runTurn(sessionId, turnId, () =>
        session.sendCustomMessage(bashRunMessage(run), { triggerTurn: true })
      )
    },

    // Delivered as a steering message at the next boundary between tool calls,
    // which is where π pulls a queued message from.
    shareBashRun(
      sessionId: SessionId,
      run: BashRunShare
    ): Promise<'delivered' | 'dropped' | 'idle'> {
      const bound = requireBound(sessionId)
      const { session } = bound
      // Outside π's streaming window a custom message would land outside every
      // boundary, with no turn left to answer it.
      if (bound.running === undefined || !session.isStreaming) return Promise.resolve('idle')
      const message = bashRunMessage(run)

      return new Promise<'delivered' | 'dropped' | 'idle'>((resolve, reject) => {
        const share: PendingShare = {
          run,
          settle: (outcome) => {
            stop()
            resolve(outcome)
          }
        }
        // π announces the steered message at the boundary that takes it, which
        // is the only observable moment the run enters the conversation.
        const stop = session.subscribe((event) => {
          if (deliveredBashRunId(event) !== message.details.id) return
          const at = bound.shares.indexOf(share)
          if (at !== -1) bound.shares.splice(at, 1)
          share.settle('delivered')
        })

        bound.shares.push(share)
        void session.sendCustomMessage(message, { deliverAs: 'steer' }).catch((cause: unknown) => {
          const at = bound.shares.indexOf(share)
          if (at !== -1) bound.shares.splice(at, 1)
          stop()
          reject(cause instanceof Error ? cause : new Error(String(cause)))
        })
      })
    },

    // `running` rather than the SDK's `isStreaming`, which lags by a microtask
    // and would answer 'idle' for a run genuinely under way.
    async steer(sessionId: SessionId, text: string): Promise<'queued' | 'idle'> {
      const bound = requireBound(sessionId)
      if (bound.running === undefined) return 'idle'
      await bound.session.steer(text)
      return 'queued'
    },

    async followUp(sessionId: SessionId, text: string): Promise<'queued' | 'idle'> {
      const bound = requireBound(sessionId)
      if (bound.running === undefined) return 'idle'
      await bound.session.followUp(text)
      return 'queued'
    },

    // π removes queued messages only as a whole, so one entry leaves by
    // clearing the queue and putting the rest back in order.
    async dequeue(sessionId: SessionId, kind: QueuedKind, text: string): Promise<boolean> {
      const bound = sessions.get(sessionId)
      if (bound === undefined) return false
      const { session } = bound
      const { steering, followUp } = session.clearQueue()
      const wanted = kind === 'steering' ? steering : followUp
      const at = wanted.indexOf(text)
      if (at !== -1) wanted.splice(at, 1)
      for (const queued of steering) await session.steer(queued)
      for (const queued of followUp) await session.followUp(queued)
      return at !== -1
    },

    async cancel(sessionId: SessionId): Promise<void> {
      const bound = sessions.get(sessionId)
      if (bound?.running === undefined) return
      // Cleared before the abort, so nothing queued and no shared run can fire
      // at a plan the user just killed.
      flushQueue(bound, sessionId)
      dropShares(bound)
      bound.running.cancel()
    },

    onEvent(listener: AdapterEventListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    // The work is dropped; the bindings are not. The document that comes back
    // after a reload finds its sessions still bound and prompts immediately.
    dispose(): void {
      for (const bound of sessions.values()) {
        bound.running?.abandon()
        dropShares(bound)
      }
    }
  }
}

function promptKind(type: AuthPrompt['type']): AuthPromptKind {
  return type === 'manual_code' ? 'manual-code' : type
}

// What the dialog shows while π works. An event Crucible has no rendering for
// is dropped rather than shown as something it is not.
function toNotice(event: AuthEvent): AuthNotice | undefined {
  switch (event.type) {
    case 'info':
      return { kind: 'info', message: event.message }
    case 'progress':
      return { kind: 'progress', message: event.message }
    case 'auth_url':
      return {
        kind: 'auth-url',
        message: event.instructions ?? 'Your browser opened for authorization.',
        url: event.url
      }
    case 'device_code':
      return {
        kind: 'device-code',
        message: 'Enter this code to authorize Crucible.',
        userCode: event.userCode,
        verificationUri: event.verificationUri
      }
    default:
      return undefined
  }
}

// A provider reduced to the facts a status needs. An api-key provider with no
// `login` is ambient-only: it can be shown, never logged into.
function facts(provider: Provider): ProviderFacts {
  const { apiKey, oauth } = provider.auth
  return {
    id: provider.id,
    name: provider.name,
    ...(oauth === undefined
      ? {}
      : {
          oauth: {
            ...(oauth.name === undefined ? {} : { name: oauth.name }),
            ...(oauth.isSubscription === undefined
              ? {}
              : { isSubscription: oauth.isSubscription })
          }
        }),
    ...(apiKey === undefined
      ? {}
      : { apiKey: { interactive: typeof apiKey.login === 'function' } })
  }
}

// The panel model's own answer is the whole result; nothing structured rides
// beside it.
function said(text: string): { content: { type: 'text'; text: string }[]; details: unknown } {
  return { content: [{ type: 'text', text }], details: {} }
}

// The tool's `inputs` parameter is a JSON object in a string; a malformed one
// throws exactly the sentence the model should read.
function parseInputs(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('`inputs` must be a JSON object mapping input names to file paths.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('`inputs` must be a JSON object mapping input names to file paths.')
  }
  const inputs: Record<string, string> = {}
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error(`The input "${name}" must be a file path string.`)
    }
    inputs[name] = value
  }
  return inputs
}

// The wire format, minted once per share: the id is what tells this run's
// arrival from another's when the entry lands.
function bashRunMessage(run: BashRunShare): {
  customType: string
  content: string
  display: boolean
  details: { id: string; command: string; output: string; exitCode?: number }
} {
  shared += 1
  return {
    customType: BASH_RUN_TYPE,
    // What the model receives: the command, its output and how it ended, said
    // plainly as a command the user ran locally.
    content:
      `The user ran this command locally and shared its output with you.\n\n` +
      `$ ${run.command}\n${run.output}\n` +
      (run.exitCode === undefined ? '(stopped before it exited)' : `(exit ${run.exitCode})`),
    display: true,
    details: {
      id: `share-${shared}`,
      command: run.command,
      output: run.output,
      ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode })
    }
  }
}

let shared = 0

// π's own image shape, built from the port's: base64 bytes and a media type,
// which is all an attachment ever was.
function toImageContent(image: ImageAttachment): {
  type: 'image'
  data: string
  mimeType: string
} {
  return { type: 'image', data: image.data, mimeType: image.mimeType }
}

function preview(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line === '') return 'an empty conversation'
  return line.length <= PREVIEW_LIMIT ? line : `${line.slice(0, PREVIEW_LIMIT)}…`
}
