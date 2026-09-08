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
  ResourceLoader,
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
  ObservedCacheMiss,
  ObservedCachedPrefix,
  ResumeRequest,
  UsageRequest
} from '../../shared/agent/adapter'
import type {
  AuthMethod,
  AuthNotice,
  AuthPromptKind,
  BashRunShare,
  CacheMissFacts,
  ChangeFact,
  HistoryMatch,
  ImageAttachment,
  ModelId,
  ModelInfo,
  ProviderState,
  QueuedEntry,
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
import { bindMonitorTools, type MonitorTools } from '../../shared/agent/monitor-tools.ts'
import { monitorPiTools } from './monitor-pi-tools.ts'
import { retentionInForce } from '../cache/retention.ts'
import { displaySafeMessage } from './adapter-error.ts'
import {
  billsPrompt,
  scanCacheMisses,
  type CacheMissTrackerOptions,
  type DetectedCacheMiss
} from './cache-miss.ts'
import { forPi, type LoadedSkill, type SkillService } from '../skills/service.ts'
import { toProviderState, type AuthFacts, type ProviderFacts } from './providers.ts'
import { crucibleAgentDir, workspaceSessionDir } from './paths.ts'
import { createQueuedImages, withImages, type QueuedImages } from './queued-images.ts'
import {
  createEventMapper,
  jumpOutcome,
  summarizeRetryOf,
  type SkillsInForce
} from './sdk-events.ts'
import { sanitizeTitle, TITLE_INSTRUCTION, titleInput } from './sdk-titler.ts'
import { branchSummaryExtension } from './sdk-branch-summary.ts'
import {
  BASH_RUN_TYPE,
  deliveredBashRunId,
  entriesToScan,
  pathSeams,
  toCacheMessage,
  toTranscript,
  userTextOf,
  type StoredMessage
} from './sdk-transcript.ts'
import { markTurnContext } from './turn-context.ts'
import { sumUsage, type StoredUsage } from './usage.ts'

// Imported dynamically because the SDK is ESM-only, so the CommonJS main
// bundle cannot `require` it and a fake-flavor launch never loads it.
type Sdk = typeof import('@earendil-works/pi-coding-agent')

interface Bound {
  session: AgentSession
  readonly workspacePath: string
  token: string
  running?: RunningTurn
  // True while a summarizing jump waits on π's summary. A summary is not a
  // turn, so this is what `cancel` reads to know there is something to abort.
  summarizing?: boolean
  /** Bash runs waiting for the boundary that delivers them, oldest first. */
  readonly shares: PendingShare[]
  // π reports its queue as text, so the pictures a queued message carries wait
  // here until that message leaves the queue, one way or the other.
  readonly queuedImages: QueuedImages
  /** The last numbers reported for this conversation, so a still count is not re-sent. */
  reported?: ReportedUsage
  // What Crucible itself did to this session since the last request it
  // watched complete. Read into a miss's `changed` facts and cleared there,
  // because they describe the span between the two compared turns.
  thinkingChanged: boolean
  jumped: boolean
  // Crucible rewrote this session's composed system prompt in that span,
  // which a changed skill set is the one thing that does.
  promptChanged: boolean
  // Whether this launch watched the request the next miss would be compared
  // against. Without that, the tool set and the role prompt of the compared
  // turn are genuinely unknown rather than unchanged.
  watchedPrevious: boolean
  /** π's skills block this session's composed prompt is currently carrying. */
  carriedBlock: string
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
  readonly cacheMisses?: { readonly count: number; readonly dollars: number }
  readonly cachedPrefix?: ObservedCachedPrefix
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
  monitors,
  skills,
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
  // The monitor behaviors, mounted the same way and bound to this session and
  // its working directory. Absent — as in `prove:sdk` — means no monitor
  // tools are mounted.
  readonly monitors?: MonitorTools
  // Crucible's three skill origins, resolved through π's own loader. Absent —
  // as in `prove:sdk` — means no folder is read and no skill is offered.
  readonly skills?: SkillService
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
  let sdkModule: Promise<Sdk> | undefined
  let modelRuntime: Promise<ModelRuntime> | undefined
  // The runtime once it has resolved, because pricing a miss happens inside a
  // synchronous event callback and a promise would be a frame too late.
  let models: ModelRuntime | undefined
  const { retention } = retentionInForce()
  // One at a time: a second login while one is live is refused.
  let liveLogin: LiveLogin | undefined
  let prompts = 0

  interface WorkspaceResources {
    // π's loader, wrapped so the skills it reports are the ones Crucible
    // resolved rather than the ones π would have discovered.
    readonly resourceLoader: ResourceLoader
    readonly settingsManager: SettingsManager
  }

  interface HeldSkills {
    /** Replaced whole on every re-read; π's loader is never reloaded for it. */
    readonly resolved: readonly LoadedSkill[]
    /** π's own `<available_skills>` text for that set, so a change is one string compare. */
    readonly block: string
  }

  // The last set read for each workspace. Held rather than re-read on demand
  // because a folder that cannot be read must leave the previous set in force,
  // and because the loader above is rebuilt far more often than skills change.
  const heldSkills = new Map<string, HeldSkills>()

  const empty: HeldSkills = { resolved: [], block: '' }

  function held(workspacePath: string): HeldSkills {
    return heldSkills.get(workspacePath) ?? empty
  }

  // Answers with the set now in force: the one just read, or — when the folder
  // could not be read — the one this workspace was already holding.
  async function readSkills(workspacePath: string): Promise<HeldSkills> {
    const resolved = await skills?.resolve(workspacePath)
    if (resolved === undefined) return held(workspacePath)
    const fresh: HeldSkills = {
      resolved,
      block: (await sdk()).formatSkillsForPrompt(forPi(resolved))
    }
    heldSkills.set(workspacePath, fresh)
    return fresh
  }

  function emit(event: AdapterEvent): void {
    for (const listener of [...listeners]) listener(event)
  }

  // Why a summarizing jump went nowhere, when Crucible's own summarizer was
  // the one that refused. π drops a hook's error, so the message crosses here
  // instead: written by the hook, read and cleared by the jump that asked.
  const summaryFailures = new Map<SessionId, string>()

  function sdk(): Promise<Sdk> {
    sdkModule ??= import('@earendil-works/pi-coding-agent')
    return sdkModule
  }

  function runtime(): Promise<ModelRuntime> {
    modelRuntime ??= sdk()
      .then((pi) => pi.ModelRuntime.create())
      .then((created) => {
        models = created
        // π's own startup pattern: the built-in catalog answers immediately,
        // and a background refresh overlays pi.dev's current model list — so
        // models newer than the installed SDK appear without a package bump.
        // Fire-and-forget with π's 15s timeout; a failure leaves the static
        // catalog in force, which is exactly what showed before this ran.
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 15_000)
        void created
          .refresh({ signal: controller.signal })
          .catch(() => {})
          .finally(() => clearTimeout(timeout))
        return created
      })
    return modelRuntime
  }

  // π's listed cache-read price, in dollars per million tokens, for a message
  // that paid for no cache read of its own. A model nothing can price falls
  // back to zero, exactly as π's own arithmetic does.
  const pricing: CacheMissTrackerOptions = {
    listedCacheReadPerMillion: (provider, model) =>
      models?.getModel(provider, model)?.cost.cacheRead
  }

  function sessionDir(workspacePath: string): string {
    return workspaceSessionDir(agentDir, workspacePath)
  }

  // Stock π except for the emptied resources below, which keep the user's
  // globally configured extensions out of a Crucible session, and the system
  // prompt, which is Crucible's outright.
  //
  // Built fresh on every call, never cached: the loader reads AGENTS.md only
  // inside reload(), so a loader cached per workspace would pin every later
  // session — in an app process that lives for days — to the file as it stood
  // when the workspace was first opened. Each session open reads the file as
  // it is now. Resumes go through here too, on purpose: a resumed conversation
  // pays one prompt-cache miss and gets the current instructions.
  async function workspaceResources(
    sessionId: SessionId,
    workspacePath: string
  ): Promise<WorkspaceResources> {
    const [pi, models] = await Promise.all([sdk(), runtime()])
    const settingsManager = pi.SettingsManager.create(workspacePath, agentDir)
    // Read before the session being composed is created, so an agent is
    // offered its workspace's skills from its very first turn.
    await readSkills(workspacePath)
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
      // π's own skill folders are never read; Crucible's three origins are
      // handed in through `getSkills` below instead.
      noSkills: true,
      // The base is ignored, so π's own prompt never reaches a session and a
      // system-prompt file discovered in any folder is dead.
      systemPromptOverride: () => systemPrompt,
      // A Crucible-owned custom-instructions mechanism is deferred, so a file
      // dropped into the agent dir must not become one by accident.
      appendSystemPromptOverride: () => [],
      // The one extension a session runs, and Crucible's own: π's branch
      // summarizer with its reply cap taken off.
      extensionFactories: [
        branchSummaryExtension({
          generate: pi.generateBranchSummary,
          stream: (model, context, options) => models.streamSimple(model, context, options),
          retry: () => settingsManager.getRetrySettings(),
          reserveTokens: () => settingsManager.getBranchSummarySettings().reserveTokens,
          retryScheduled: (attempt, maxAttempts, delayMs, errorMessage) =>
            emit({
              type: 'summarize_retry',
              sessionId,
              attempt,
              maxAttempts,
              delayMs,
              message: displaySafeMessage(errorMessage, 'The summary could not be written.')
            }),
          failed: (message) => summaryFailures.set(sessionId, message)
        })
      ]
    })
    await resourceLoader.reload()
    return {
      resourceLoader: withCrucibleSkills(resourceLoader, () => held(workspacePath).resolved),
      settingsManager
    }
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
            parameter.kind === 'map'
              ? {
                  type: 'object',
                  additionalProperties: { type: 'string' },
                  description: parameter.description
                }
              : { type: 'string', description: parameter.description }
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
            inputs?: Record<string, string> | string
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
          if (tool.name === 'crucible_resume') {
            return said(await behaviors.resume(sessionId, given.runId ?? ''))
          }
          return said(await behaviors.list(sessionId))
        }
      }
    })
  }

  // The monitor behaviors as π tools, bound to this session and the directory
  // it was opened at: a monitor's checks run where its agent works, and that
  // is fixed when the monitor is set.
  function monitorCustomTools(sessionId: SessionId, workspacePath: string): ToolDefinition[] {
    if (monitors === undefined) return []
    return monitorPiTools(
      bindMonitorTools(monitors, { kind: 'session', sessionId }, workspacePath)
    )
  }

  async function open(
    sessionId: SessionId,
    workspacePath: string,
    sessionManager: SessionManager,
    preferred?: { model?: ModelId; thinkingLevel?: ThinkingLevel }
  ): Promise<AgentSession> {
    const pi = await sdk()
    const { resourceLoader, settingsManager } = await workspaceResources(sessionId, workspacePath)

    const options: CreateAgentSessionOptions = {
      cwd: workspacePath,
      agentDir,
      sessionManager,
      settingsManager,
      resourceLoader,
      modelRuntime: await runtime(),
      customTools: [
        ...panelCustomTools(sessionId, workspacePath),
        ...runCustomTools(sessionId, workspacePath),
        ...monitorCustomTools(sessionId, workspacePath)
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
    // Read first: clearing π's queue raises a queue event of its own, which
    // would empty this memory before the pictures could be paired back on.
    const held = bound.queuedImages.take()
    const { steering, followUp } = bound.session.clearQueue()
    const messages: QueuedMessage[] = [
      ...withImages(steering, held.steering).map(
        (entry): QueuedMessage => ({ kind: 'steering', ...entry })
      ),
      ...withImages(followUp, held.followUp).map(
        (entry): QueuedMessage => ({ kind: 'followUp', ...entry })
      )
    ]
    if (messages.length === 0) return
    emit({ type: 'queue_flushed', sessionId, messages })
  }

  /** One message into π's queue, with the memory of its pictures beside it. */
  async function queueInto(
    bound: Bound,
    kind: QueuedKind,
    text: string,
    images?: readonly ImageAttachment[]
  ): Promise<void> {
    // Remembered first, because π reports its queue from inside the call
    // below with nothing awaited in between: by the time the queue event
    // arrives the pictures have to be here already.
    const forget = bound.queuedImages.add(kind, text, images)
    const attached = images === undefined || images.length === 0
      ? undefined
      : images.map(toImageContent)
    try {
      if (kind === 'steering') await bound.session.steer(text, attached)
      else await bound.session.followUp(text, attached)
    } catch (refused) {
      // π refuses a message naming one of its extension commands, and never
      // queues it. Keeping it here would leave this memory a message longer
      // than π's queue, and the pairing is by position.
      forget()
      throw refused
    }
  }

  // π's retries of a branch summary, for as long as the jump that asked for
  // one is in flight. The returned call stops watching and is what makes the
  // session cancellable only while there is genuinely a summary to abort.
  function watchSummary(bound: Bound, sessionId: SessionId): () => void {
    bound.summarizing = true
    const unsubscribe = bound.session.subscribe((event) => {
      const retry = summarizeRetryOf(event, sessionId)
      if (retry !== undefined) emit(retry)
    })
    return () => {
      bound.summarizing = false
      unsubscribe()
    }
  }

  // Read again here, so a skill an agent wrote mid-session is offered to the
  // very next thing the user types; a folder that cannot be read leaves the
  // previous set in force rather than turning a send into an error.
  async function skillsForTurn(bound: Bound): Promise<SkillsInForce> {
    const inForce = await readSkills(bound.workspacePath)

    if (bound.carriedBlock !== inForce.block) {
      // Setting the tool set is what makes π recompose the system prompt, and
      // the set handed back is the one the session already had.
      bound.session.setActiveToolsByName(bound.session.getActiveToolNames())
      bound.carriedBlock = inForce.block
      // Rewriting the prompt re-bills the cache, so the next miss in this
      // session says the prompt changed rather than claiming nothing did.
      bound.promptChanged = true
    }

    return { skills: inForce.resolved, cwd: bound.workspacePath }
  }

  // The skills this workspace is holding, without reading a folder: what a
  // transcript built now is attributed against.
  function skillsHeld(workspacePath: string): SkillsInForce {
    return { skills: held(workspacePath).resolved, cwd: workspacePath }
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
    const mapper = createEventMapper(await skillsForTurn(bound), bound.queuedImages)

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

      // Detection runs per completed assistant message, aborted and errored
      // ones included: π's scan exempts none of them, and neither does this.
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        observeMessage(sessionId, turnId, bound, event.message as StoredMessage)
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

  // What Crucible itself did between the two compared turns. A span this
  // launch did not watch is unknown, and unknown is never guessed into an
  // answer.
  interface Span {
    readonly watched: boolean
    readonly thinkingChanged: boolean
    readonly jumped: boolean
    readonly promptChanged: boolean
  }

  function fact(changed: boolean): ChangeFact {
    return changed ? 'yes' : 'no'
  }

  /** Rounded to a hundredth of a cent, so no dollar figure carries a tail. */
  function round(dollars: number): number {
    return Math.round(dollars * 10_000) / 10_000
  }

  // A miss on a just-completed assistant message, detected as π detects one:
  // the conversation as it stands is scanned for the request this message is
  // compared against, and the message itself is not part of that scan yet.
  function observeMessage(
    sessionId: SessionId,
    turnId: TurnId,
    bound: Bound,
    message: StoredMessage
  ): void {
    const scanned = toCacheMessage(message)
    if (scanned === undefined) return
    const entries = bound.session.sessionManager
      .getEntries()
      .filter((entry) => (entry as { message?: unknown }).message !== message)
    const miss = scanCacheMisses(entriesToScan(entries), pricing).tracker.observe(scanned)

    const span: Span = {
      watched: bound.watchedPrevious,
      thinkingChanged: bound.thinkingChanged,
      jumped: bound.jumped,
      promptChanged: bound.promptChanged
    }
    if (billsPrompt(scanned)) {
      // This message is what the next one is compared against, and the span
      // since it is empty until something happens in it.
      bound.watchedPrevious = true
      bound.thinkingChanged = false
      bound.jumped = false
      bound.promptChanged = false
    }
    if (miss === undefined) return

    emit({
      type: 'cache_miss',
      sessionId,
      turnId,
      miss: {
        provider: scanned.provider,
        model: scanned.model,
        ...(bound.session.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: bound.session.thinkingLevel }),
        tokensRebilled: miss.missedTokens,
        dollarsRebilled: round(miss.missedCost),
        gapMs: miss.gapMs,
        changed: {
          model: fact(miss.modelChanged),
          thinking: span.watched ? fact(span.thinkingChanged) : 'unknown',
          jump: span.watched ? fact(span.jumped) : 'unknown',
          // The comparison starts over at a compaction, so a detected miss
          // never spans one.
          compaction: 'no',
          // The tool set cannot change within one bound conversation in one
          // launch; the composed prompt can, when the skills in force change
          // under it. Across launches Crucible genuinely does not know either.
          tools: span.watched ? 'no' : 'unknown',
          rolePrompt: span.watched ? fact(span.promptChanged) : 'unknown'
        }
      } satisfies ObservedCacheMiss
    })
  }

  // A restored seam states what the file still holds. What Crucible did
  // between two turns of an earlier launch was never written down, so those
  // facts stay unknown and the seam says nothing about them.
  function restoredFacts(miss: DetectedCacheMiss): CacheMissFacts {
    return {
      tokensRebilled: miss.missedTokens,
      dollarsRebilled: round(miss.missedCost),
      gapMs: miss.gapMs,
      modelChanged: fact(miss.modelChanged),
      thinkingChanged: 'unknown',
      jump: 'unknown',
      retention
    }
  }

  // The seams of a conversation's current path, by the message that paid.
  // Rebuilt from the whole entry sequence, exactly as π rebuilds its notices
  // on resume and exactly as the ledger and the badge counted them, so a
  // conversation reopens showing the seams it showed live — across jumps
  // included.
  function seamsOf(
    manager: SessionManager,
    messages: readonly StoredMessage[]
  ): Map<number, CacheMissFacts> {
    const seams = new Map<number, CacheMissFacts>()
    for (const [at, miss] of pathSeams(manager.getEntries(), messages, pricing)) {
      seams.set(at, restoredFacts(miss))
    }
    return seams
  }

  // Every branch of the conversation, exactly as the money is counted, and
  // the prefix the last billed request of it left behind. One pass, because
  // the scan that counts the misses is the scan that ends holding the prefix.
  function missTotals(manager: SessionManager): {
    readonly totals: { readonly count: number; readonly dollars: number }
    readonly cachedPrefix?: ObservedCachedPrefix
  } {
    const { totals, tracker } = scanCacheMisses(entriesToScan(manager.getEntries()), pricing)
    const prefix = tracker.cachedPrefix()
    return {
      totals: { count: totals.count, dollars: totals.dollars },
      ...(prefix === undefined
        ? {}
        : {
            cachedPrefix: {
              at: new Date(prefix.at).toISOString(),
              tokens: prefix.tokens,
              rebillDollars: prefix.rebillDollars
            }
          })
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
    // jump. The misses are counted the same way, for the same reason.
    const spent = usageOf(bound.session.sessionManager)
    const { totals: misses, cachedPrefix } = missTotals(bound.session.sessionManager)
    const next: ReportedUsage = {
      usedTokens: usage.tokens,
      contextWindow: usage.contextWindow,
      ...(spent === undefined ? {} : { cost: spent.totalCost }),
      cacheMisses: misses,
      ...(cachedPrefix === undefined ? {} : { cachedPrefix })
    }
    const last = bound.reported
    if (
      last !== undefined &&
      last.usedTokens === next.usedTokens &&
      last.contextWindow === next.contextWindow &&
      last.cost === next.cost &&
      last.cacheMisses?.count === misses.count &&
      last.cacheMisses.dollars === misses.dollars &&
      // The prefix moves when a request bills a prompt, which the tokens
      // above may not: a re-sent conversation of the same size still re-dates
      // what the provider is holding.
      last.cachedPrefix?.at === cachedPrefix?.at &&
      last.cachedPrefix?.tokens === cachedPrefix?.tokens
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
        shares: [],
        queuedImages: createQueuedImages(),
        // Nothing of this conversation's earlier turns was watched here, so
        // the first miss compares against a request this launch never saw.
        thinkingChanged: false,
        jumped: false,
        promptChanged: false,
        watchedPrevious: false,
        carriedBlock: held(request.workspacePath).block
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
      // Nothing was queued behind the conversation this session no longer has,
      // so the pictures waiting for that queue go with it.
      bound.queuedImages.take()
      // The old conversation's numbers described a conversation this session
      // no longer has, and so did the span its next miss would be measured
      // over.
      bound.reported = undefined
      bound.thinkingChanged = false
      bound.jumped = false
      bound.promptChanged = false
      bound.watchedPrevious = false
      // The fresh conversation was composed from the same loader, so it is
      // carrying whatever skills block the workspace holds now.
      bound.carriedBlock = held(bound.workspacePath).block
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
        shares: [],
        queuedImages: createQueuedImages(),
        thinkingChanged: false,
        jumped: false,
        promptChanged: false,
        watchedPrevious: false,
        carriedBlock: held(request.workspacePath).block
      }
      sessions.set(request.sessionId, bound)
      reportUsage(request.sessionId, bound)
      return describe(bound, true)
    },

    async transcript(sessionId: SessionId): Promise<readonly TranscriptItem[]> {
      const bound = requireBound(sessionId)
      const { session } = bound
      const { messages } = session
      // Seams in place: a reopened conversation shows where it paid twice, and
      // its skill reads read as skill reads.
      return toTranscript(
        messages,
        seamsOf(session.sessionManager, messages),
        skillsHeld(bound.workspacePath)
      )
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
    ): Promise<{ cancelled: boolean; editorText?: string }> {
      const bound = requireBound(sessionId)
      // Watched only for the call that pays for a summary, so a compaction
      // retry inside somebody's turn is never narrated as this jump's.
      const watching = summarize ? watchSummary(bound, sessionId) : undefined
      summaryFailures.delete(sessionId)
      let navigated
      try {
        navigated = await bound.session.navigateTree(ref, { summarize })
      } finally {
        watching?.()
      }
      const failure = summaryFailures.get(sessionId)
      if (failure !== undefined) {
        summaryFailures.delete(sessionId)
        throw new Error(failure)
      }
      const outcome = jumpOutcome(navigated)
      // Nothing moved, so nothing about the conversation changed either.
      if (outcome.cancelled) return outcome
      // The branch under the session changed, so whatever was last reported
      // counted messages that are no longer on the path. π compares straight
      // across a jump, so the comparison is not reset — it is recorded as a
      // fact about the span instead.
      bound.reported = undefined
      bound.jumped = true
      return outcome
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
      const bound = requireBound(sessionId)
      bound.session.setThinkingLevel(level as Parameters<AgentSession['setThinkingLevel']>[0])
      // A fact about the span between the next miss's two turns: Crucible
      // changed the level in it, whatever that turns out to have cost.
      bound.thinkingChanged = true
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
      images?: readonly ImageAttachment[],
      context?: string
    ): Promise<void> {
      const bound = requireBound(sessionId)
      const { session } = bound
      const options =
        images === undefined || images.length === 0
          ? undefined
          : { images: images.map(toImageContent) }
      // π stores the message it was sent, so context that must reach the model
      // without entering the conversation anyone reads goes in marked and
      // comes back out through `userTextOf`.
      const sent = context === undefined ? text : markTurnContext(context, text)
      // Held from before the turn is announced, because the shell asks for a
      // title the moment it hears the start and π appends the prompt to its
      // own list some way into the call below. What was typed, never the
      // context: the titler names sessions after the conversation.
      bound.asked = text
      return runTurn(sessionId, turnId, () => session.prompt(sent, options)).finally(() => {
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
    async steer(
      sessionId: SessionId,
      text: string,
      images?: readonly ImageAttachment[]
    ): Promise<'queued' | 'idle'> {
      const bound = requireBound(sessionId)
      if (bound.running === undefined) return 'idle'
      await queueInto(bound, 'steering', text, images)
      return 'queued'
    },

    async followUp(
      sessionId: SessionId,
      text: string,
      images?: readonly ImageAttachment[]
    ): Promise<'queued' | 'idle'> {
      const bound = requireBound(sessionId)
      if (bound.running === undefined) return 'idle'
      await queueInto(bound, 'followUp', text, images)
      return 'queued'
    },

    // π removes queued messages only as a whole, so one entry leaves by
    // clearing the queue and putting the rest back in order, pictures included.
    async dequeue(
      sessionId: SessionId,
      kind: QueuedKind,
      text: string
    ): Promise<QueuedEntry | undefined> {
      const bound = sessions.get(sessionId)
      if (bound === undefined) return undefined
      // Read first: clearing π's queue raises a queue event of its own, which
      // would empty this memory before the pictures could be paired back on.
      const held = bound.queuedImages.take()
      const cleared = bound.session.clearQueue()
      const steering = [...withImages(cleared.steering, held.steering)]
      const followUp = [...withImages(cleared.followUp, held.followUp)]
      const wanted = kind === 'steering' ? steering : followUp
      const at = wanted.findIndex((entry) => entry.text === text)
      const removed = at === -1 ? undefined : wanted.splice(at, 1)[0]
      for (const entry of steering) await queueInto(bound, 'steering', entry.text, entry.images)
      for (const entry of followUp) await queueInto(bound, 'followUp', entry.text, entry.images)
      return removed
    },

    // Stop what this session is doing, whatever that is. A summarizing jump
    // is not a turn, so it is stopped by its own abort — π drops out of the
    // backoff sleep at once rather than waiting the delay out.
    async cancel(sessionId: SessionId): Promise<void> {
      const bound = sessions.get(sessionId)
      if (bound === undefined) return
      if (bound.summarizing === true) bound.session.abortBranchSummary()
      if (bound.running === undefined) return
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

// One answer replaced and every other left π's own: the skills a session is
// composed with are the ones Crucible resolved at its own three origins.
function withCrucibleSkills(
  base: DefaultResourceLoader,
  current: () => readonly LoadedSkill[]
): ResourceLoader {
  return {
    getExtensions: () => base.getExtensions(),
    // Read on every prompt rebuild, so a set replaced between turns is the set
    // the next turn is composed with.
    getSkills: () => ({ skills: forPi(current()), diagnostics: [] }),
    getPrompts: () => base.getPrompts(),
    getThemes: () => base.getThemes(),
    getAgentsFiles: () => base.getAgentsFiles(),
    getSystemPrompt: () => base.getSystemPrompt(),
    getSystemPromptSource: () => base.getSystemPromptSource(),
    getAppendSystemPrompt: () => base.getAppendSystemPrompt(),
    getAppendSystemPromptSources: () => base.getAppendSystemPromptSources(),
    extendResources: (paths) => base.extendResources(paths),
    reload: (options) => base.reload(options)
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
// The schema says object, but a model that double-encodes is decoded rather
// than refused: the string case costs nothing to accept.
function parseInputs(raw: Record<string, string> | string | undefined): Record<string, string> {
  if (raw === undefined) return {}
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    if (raw.trim() === '') return {}
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('`inputs` must be a JSON object mapping input names to file paths.')
    }
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
