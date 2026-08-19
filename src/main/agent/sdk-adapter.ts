import type {
  AgentSession,
  CreateAgentSessionOptions,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import type {
  AdapterEvent,
  AdapterEventListener,
  BindRequest,
  Binding,
  ConversationAdapter,
  ResumeRequest
} from '../../shared/agent/adapter'
import type {
  HistoryMatch,
  ModelId,
  ModelInfo,
  SessionId,
  ThinkingLevel,
  TranscriptItem,
  TurnId,
  Unsubscribe
} from '../../shared/agent/port'
// Spelled with their extensions so this module can also be loaded by plain
// Node — that is what `npm run prove:sdk` does, and Node's ESM resolver has no
// extension guessing. Every other import here is type-only and erased.
import { displaySafeMessage } from './adapter-error.ts'
import { createEventMapper } from './sdk-events.ts'
import { toTranscript } from './sdk-transcript.ts'

/**
 * The adapter contract backed by the real π SDK — main only, and the only
 * module in Crucible that opens a paid session.
 *
 * `createSdkAdapter()` is the whole interface: no options, because nothing
 * about a session is a caller's to choose. What it runs is stock π (A17): the
 * built-in tools, the stock system prompt, the workspace's own context files
 * and skills, and the user's credentials and custom models. Each bound session
 * is a persistent π session whose working directory is that session's workspace
 * folder, so `AGENTS.md`, `.pi/skills` and the rest resolve exactly as they do
 * for the CLI in that folder.
 *
 * The one thing it deliberately does not load is the legacy system. The user's
 * global settings name it — `packages: ["../../repos/pi-extensions"]` — and
 * that is precisely the line this adapter must not honor (SA-3). It does that
 * by building the resource loader itself: settings are read as the user wrote
 * them, then `packages` and `extensions` are overridden to empty and the loader
 * is built with `noExtensions`, so no extension and no package resource of any
 * origin reaches a Crucible session. Everything else about the loader is the
 * default, which is what keeps "stock π" true of the rest.
 *
 * π storage stays here (ADR 0004). Above this module a conversation is an
 * opaque binding token; here it is a session file, and the translation between
 * the two — create, rebind, reset, resume, search — happens through π's public
 * session APIs and nowhere else. Nothing above ever sees a path.
 *
 * The SDK is imported dynamically for two reasons: it is ESM-only, so the
 * CommonJS main bundle cannot `require` it, and a fake-flavor launch then never
 * loads it at all (SA-8).
 */

/** The π module, loaded once and only when this adapter is actually used. */
type Sdk = typeof import('@earendil-works/pi-coding-agent')

/** What a bound session holds while it is bound. */
interface Bound {
  session: AgentSession
  readonly workspacePath: string
  token: string
  /** The turn in flight, if any: one per session, many per adapter. */
  running?: RunningTurn
}

/** A turn in flight, from the outside. */
interface RunningTurn {
  /** Stop the underlying run; the turn ends as cancelled (SA-6). */
  cancel(): void
  /** Abandon it with its document: the turn says nothing more at all. */
  abandon(): void
}

/** How many history entries one search may answer with. */
const HISTORY_LIMIT = 50

/** How much of a stored first message becomes a search result's preview. */
const PREVIEW_LIMIT = 140

export function createSdkAdapter(): ConversationAdapter {
  const listeners = new Set<AdapterEventListener>()
  const sessions = new Map<SessionId, Bound>()
  /** One resource loader per workspace folder, built on first use. */
  const resources = new Map<string, Promise<WorkspaceResources>>()
  let sdkModule: Promise<Sdk> | undefined
  let modelRuntime: Promise<ModelRuntime> | undefined

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

  /**
   * The loader and settings one workspace's sessions share. Stock π everywhere
   * except the two lines that keep the legacy system out (SA-3).
   */
  function workspaceResources(workspacePath: string): Promise<WorkspaceResources> {
    const existing = resources.get(workspacePath)
    if (existing !== undefined) return existing

    const built = (async (): Promise<WorkspaceResources> => {
      const pi = await sdk()
      const agentDir = pi.getAgentDir()
      const settingsManager = pi.SettingsManager.create(workspacePath, agentDir)
      settingsManager.applyOverrides({ packages: [], extensions: [] })
      const resourceLoader = new pi.DefaultResourceLoader({
        cwd: workspacePath,
        agentDir,
        settingsManager,
        noExtensions: true
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

  /** One π session, opened against a session manager the caller chose. */
  async function open(
    workspacePath: string,
    sessionManager: SessionManager,
    preferred?: { model?: ModelId; thinkingLevel?: ThinkingLevel }
  ): Promise<AgentSession> {
    const pi = await sdk()
    const { resourceLoader, settingsManager } = await workspaceResources(workspacePath)

    const options: CreateAgentSessionOptions = {
      cwd: workspacePath,
      agentDir: pi.getAgentDir(),
      sessionManager,
      settingsManager,
      resourceLoader,
      modelRuntime: await runtime()
    }

    if (preferred?.model !== undefined) {
      // A preference the credentials cannot reach is not an error: the SDK's
      // own fallback answers, and what is reported afterwards is what is
      // actually in effect (MO-4).
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

  /** What a session is worth saying about it, once it is open. */
  function describe(bound: Bound, restored: boolean): Binding {
    const model = bound.session.model
    return {
      token: bound.token,
      model: model === undefined ? undefined : modelIdOf(model),
      thinkingLevel: bound.session.thinkingLevel,
      restored
    }
  }

  /** The token a session is known by: its own file, which never leaves here. */
  function tokenOf(session: AgentSession): string {
    return session.sessionFile ?? session.sessionId
  }

  function requireBound(sessionId: SessionId): Bound {
    const bound = sessions.get(sessionId)
    if (bound === undefined) throw new Error('That session is not bound to a conversation.')
    return bound
  }

  /** Stop the work, then let go of the session, in that order. */
  function close(session: AgentSession): void {
    void (async () => {
      try {
        await session.abort()
      } catch {
        // Nothing left to tell: whoever owned this session has stopped
        // speaking for it.
      }
      try {
        session.dispose()
      } catch {
        // Same.
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
          // The session's own file carries its model and thinking level, so
          // nothing is forced on a conversation being rebound (MO-3).
          session = await open(
            request.workspacePath,
            pi.SessionManager.open(request.token, undefined, request.workspacePath)
          )
          restored = true
        } catch {
          // The conversation is gone — deleted, moved, or written by a build
          // that is no longer here. A fresh one is bound instead, and the
          // caller is told plainly that nothing was restored.
          session = undefined
        }
      }

      session ??= await open(request.workspacePath, pi.SessionManager.create(request.workspacePath), {
        model: request.preferredModel,
        thinkingLevel: request.preferredThinkingLevel
      })

      const bound: Bound = {
        session,
        workspacePath: request.workspacePath,
        token: tokenOf(session)
      }
      sessions.set(request.sessionId, bound)
      return describe(bound, restored)
    },

    async reset(sessionId: SessionId): Promise<Binding> {
      const bound = requireBound(sessionId)
      const pi = await sdk()
      const previous = bound.session

      // The old conversation is detached, not deleted: its file stays where π
      // put it and it stays findable through history search (A25).
      bound.running?.abandon()
      close(previous)

      const session = await open(
        bound.workspacePath,
        pi.SessionManager.create(bound.workspacePath),
        {
          model: previous.model === undefined ? undefined : modelIdOf(previous.model),
          thinkingLevel: previous.thinkingLevel
        }
      )
      bound.session = session
      bound.token = tokenOf(session)
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
        request.workspacePath,
        pi.SessionManager.open(request.ref, undefined, request.workspacePath)
      )
      const bound: Bound = {
        session,
        workspacePath: request.workspacePath,
        token: tokenOf(session)
      }
      sessions.set(request.sessionId, bound)
      return describe(bound, true)
    },

    async transcript(sessionId: SessionId): Promise<readonly TranscriptItem[]> {
      return toTranscript(requireBound(sessionId).session.messages)
    },

    release(sessionId: SessionId): void {
      const bound = sessions.get(sessionId)
      if (bound === undefined) return
      bound.running?.abandon()
      // The session object is let go; its file is not touched. Removal forgets
      // a sidebar entry and nothing else (A24).
      close(bound.session)
      sessions.delete(sessionId)
    },

    async searchHistory(workspacePath: string, query: string): Promise<readonly HistoryMatch[]> {
      const pi = await sdk()
      const wanted = query.trim().toLowerCase()
      const found = await pi.SessionManager.list(workspacePath)

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
          // The ref is the file path, which is why it never leaves this module
          // as anything but an opaque string: the preview is what is shown.
          ref: info.path,
          preview: preview(info.name ?? info.firstMessage),
          at: info.modified.toISOString()
        }))
    },

    sameConversation(token: string, ref: string): boolean {
      return token === ref
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
          // A model's own native levels, as the SDK reports them for it. No
          // low/medium/high is hard-coded anywhere in Crucible (A22).
          thinkingLevels: pi.getSupportedThinkingLevels(model) as readonly ThinkingLevel[]
        }))
        .sort((left, right) => left.label.localeCompare(right.label))
    },

    async setModel(sessionId: SessionId, model: ModelId): Promise<void> {
      await requireBound(sessionId).session.setModel(await resolveModel(model))
    },

    async setThinkingLevel(sessionId: SessionId, level: ThinkingLevel): Promise<void> {
      requireBound(sessionId).session.setThinkingLevel(
        level as Parameters<AgentSession['setThinkingLevel']>[0]
      )
    },

    async prompt(sessionId: SessionId, turnId: TurnId, text: string): Promise<void> {
      const bound = requireBound(sessionId)
      const { session } = bound
      const mapper = createEventMapper()

      let cancelled = false
      let abandoned = false
      /**
       * How this turn would end if the stream stopped now. A failure the SDK
       * reported is remembered rather than emitted: if it is transient the SDK
       * retries behind this seam, and only its last word counts.
       */
      let outcome: AdapterEvent = { type: 'turn_ended', sessionId, turnId }

      emit({ type: 'turn_started', sessionId, turnId })

      const unsubscribe = session.subscribe((event) => {
        if (abandoned) return
        const mapped = mapper.map(event, { sessionId, turnId })
        if (mapped === undefined) return
        if (mapped.type === 'turn_error') {
          outcome = mapped
          return
        }
        if (mapped.type === 'text_delta') {
          // Text arriving after a failed message is the SDK's own retry
          // succeeding: the turn is no longer failing.
          outcome = { type: 'turn_ended', sessionId, turnId }
        }
        emit(mapped)
      })

      bound.running = {
        cancel(): void {
          cancelled = true
          // Aborting the run is what stops a paid request from streaming on
          // unseen (CAN-6).
          void session.abort()
        },
        abandon(): void {
          abandoned = true
          void session.abort()
        }
      }

      try {
        await session.prompt(text)
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

      // Cancelled is its own outcome, decided here because only the adapter
      // that called `abort()` knows an abort happened (A3, SA-6).
      emit(cancelled ? { type: 'turn_cancelled', sessionId, turnId } : outcome)

      const usage = session.getContextUsage()
      // Absent data shows as absent: no usage event means the meter keeps
      // saying nothing rather than showing a guess (SA-7, TB-2).
      if (usage?.tokens != null) {
        emit({
          type: 'usage',
          sessionId,
          usedTokens: usage.tokens,
          contextWindow: usage.contextWindow
        })
      }
    },

    async cancel(sessionId: SessionId): Promise<void> {
      sessions.get(sessionId)?.running?.cancel()
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
      for (const bound of sessions.values()) bound.running?.abandon()
    }
  }
}

function preview(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line === '') return 'an empty conversation'
  return line.length <= PREVIEW_LIMIT ? line : `${line.slice(0, PREVIEW_LIMIT)}…`
}
