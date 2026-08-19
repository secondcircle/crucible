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
// Spelled with their extensions so plain Node can load this module too: its
// ESM resolver does no extension guessing. Every other import here is
// type-only and erased.
import { displaySafeMessage } from './adapter-error.ts'
import { createEventMapper } from './sdk-events.ts'
import { toTranscript } from './sdk-transcript.ts'

// The only module in Crucible that opens a paid session. It takes no options
// because nothing about a π session is a caller's to choose, and it is where
// π storage stops: above it a conversation is only an opaque token.
//
// The SDK is imported dynamically because it is ESM-only, so the CommonJS main
// bundle cannot `require` it, and a fake-flavor launch then never loads it.
type Sdk = typeof import('@earendil-works/pi-coding-agent')

interface Bound {
  session: AgentSession
  readonly workspacePath: string
  token: string
  /** One per session, many per adapter. */
  running?: RunningTurn
}

interface RunningTurn {
  cancel(): void
  /** Abandon it with its document: the turn says nothing more at all. */
  abandon(): void
}

const HISTORY_LIMIT = 50

const PREVIEW_LIMIT = 140

export function createSdkAdapter(): ConversationAdapter {
  const listeners = new Set<AdapterEventListener>()
  const sessions = new Map<SessionId, Bound>()
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

  // Stock π except for the emptied `packages` and `extensions` and
  // `noExtensions` below, which is what keeps the user's globally configured
  // extensions, the legacy system among them, out of a Crucible session.
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
      // own fallback answers, and what gets reported back is what is in
      // effect.
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
          // No preference is passed: the session's own file already carries
          // the model and thinking level it was left on.
          session = await open(
            request.workspacePath,
            pi.SessionManager.open(request.token, undefined, request.workspacePath)
          )
          restored = true
        } catch {
          // The conversation is gone: deleted, moved, or written by a build
          // that is no longer here. A fresh one is bound instead and the
          // caller is told nothing was restored.
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
      // put it and stays findable through history search.
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
      // a sidebar entry and nothing else.
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
      // A reported failure is remembered rather than emitted, because the SDK
      // retries transient ones behind this seam and only its last word counts.
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
          // unseen.
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

      // Decided here because only the adapter that called `abort()` knows an
      // abort happened.
      emit(cancelled ? { type: 'turn_cancelled', sessionId, turnId } : outcome)

      const usage = session.getContextUsage()
      // No usage event at all, rather than a guess, when the SDK reports
      // nothing.
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
