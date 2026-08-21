import type {
  AgentSession,
  ToolDefinition
} from '@earendil-works/pi-coding-agent'
import type { TranscriptItem, Unsubscribe } from '../../shared/agent/port'
// Spelled with extensions so plain Node can load this module too.
import { composeSystemPrompt } from '../agent/system-prompt.ts'
import { toTranscript, type StoredMessage } from '../agent/sdk-transcript.ts'
import type {
  NodeSession,
  NodeSessionFactory,
  NodeSessionRequest,
  NodeSessionStats
} from './node-session.ts'

// A node is a fresh π session with two injected tools and no interactive
// user: in-memory session and settings managers, so nothing of π's state is
// read or written (ADR 0015), and a full prompt override composed of the
// node's role and the standing prompt (ADR 0012).

type Sdk = typeof import('@earendil-works/pi-coding-agent')

export interface SdkNodeSessionOptions {
  /** Appended to every node's role prompt, like every agent Crucible starts. */
  readonly standingPrompt: string
  /** A scratch agent dir for π's resource loader; nothing durable lives in it. */
  readonly agentDir: string
}

export function createSdkNodeSessionFactory({
  standingPrompt,
  agentDir
}: SdkNodeSessionOptions): NodeSessionFactory {
  let sdkModule: Promise<Sdk> | undefined
  let modelRuntime: Promise<import('@earendil-works/pi-coding-agent').ModelRuntime> | undefined

  function sdk(): Promise<Sdk> {
    sdkModule ??= import('@earendil-works/pi-coding-agent')
    return sdkModule
  }

  function runtime(): ReturnType<Sdk['ModelRuntime']['create']> {
    modelRuntime ??= sdk().then((pi) => pi.ModelRuntime.create())
    return modelRuntime
  }

  return {
    async start(request: NodeSessionRequest): Promise<NodeSession> {
      const pi = await sdk()
      const models = await runtime()

      const match = /^([^/]+)\/(.+?)(?::([a-z]+))?$/.exec(request.model)
      if (match === null) throw new Error(`bad model spec "${request.model}"`)
      const model = models.getModel(match[1], match[2])
      if (model === undefined) throw new Error(`model not found: ${request.model}`)
      const thinkingLevel = (match[3] ?? 'medium') as 'low' | 'medium' | 'high'

      const customTools: ToolDefinition[] = [
        nodeTool(
          'complete_node',
          'Complete Node',
          "Declare this node's work finished. Only call when every required output file is " +
            'written. Include `verdict` when the task declares a verdict schema.',
          {
            type: 'object',
            required: ['summary'],
            properties: {
              summary: {
                type: 'string',
                description: 'One-paragraph summary of what was done.'
              },
              verdict: { description: 'Verdict matching the declared schema.' }
            }
          },
          (params) => {
            const given = (params ?? {}) as { summary?: string; verdict?: unknown }
            return request.onComplete({
              summary: given.summary ?? '',
              ...(given.verdict === undefined ? {} : { verdict: given.verdict })
            })
          }
        ),
        nodeTool(
          'raise_blocker',
          'Raise Blocker',
          'Alert the orchestrating agent that something abnormal prevents doing this task ' +
            'properly (broken environment, malformed inputs, missing access). Work pauses until ' +
            'a response arrives.',
          {
            type: 'object',
            required: ['reason'],
            properties: {
              reason: {
                type: 'string',
                description: 'Short reason someone can act on: 1-3 sentences, never an essay.'
              },
              details: {
                type: 'string',
                description: 'Relevant detail: commands run, errors seen, what is needed.'
              },
              artifact: {
                type: 'string',
                description:
                  'Absolute path of a document to review before deciding. For any decision with ' +
                  'substance, write a well-formatted markdown file FIRST and pass its path here.'
              }
            }
          },
          (params) => {
            const given = (params ?? {}) as {
              reason?: string
              details?: string
              artifact?: string
            }
            return request.onBlocker({
              reason: given.reason ?? '',
              ...(given.details === undefined ? {} : { details: given.details }),
              ...(given.artifact === undefined ? {} : { artifact: given.artifact })
            })
          }
        )
      ]

      const resourceLoader = new pi.DefaultResourceLoader({
        cwd: request.cwd,
        agentDir,
        noExtensions: true,
        noPromptTemplates: true,
        noSkills: true,
        systemPromptOverride: () =>
          composeSystemPrompt({ role: request.rolePrompt, standing: standingPrompt }),
        appendSystemPromptOverride: () => []
      })
      await resourceLoader.reload()

      const { session } = await pi.createAgentSession({
        cwd: request.cwd,
        agentDir,
        model,
        thinkingLevel,
        modelRuntime: models,
        resourceLoader,
        // π's allowlist covers custom tools too, so a node that lists only file
        // tools loses the two it completes through.
        tools: [...request.tools, ...customTools.map((tool) => tool.name)] as never,
        customTools,
        sessionManager: pi.SessionManager.inMemory(request.cwd),
        settingsManager: pi.SettingsManager.inMemory()
      })

      return wrap(session)
    }
  }
}

function wrap(session: AgentSession): NodeSession {
  const activityListeners = new Set<(now: string | undefined) => void>()
  const inflight = new Map<string, string>()

  const unsubscribe = session.subscribe((event) => {
    const now = liveness(event as Record<string, unknown>, inflight)
    if (now === null) return
    for (const listener of [...activityListeners]) listener(now)
  })

  return {
    async prompt(text: string): Promise<void> {
      // Model trouble never rejects the loop: a turn that failed ends and
      // the engine's nudge/stall machinery takes it from there.
      try {
        await session.prompt(text)
      } catch {
        // The session's own subscribers saw whatever there was to see.
      }
    },

    async abort(): Promise<void> {
      await session.abort().catch(() => {})
    },

    isStreaming(): boolean {
      return session.isStreaming
    },

    stats(): NodeSessionStats {
      const transcript = toTranscript(session.messages as unknown as StoredMessage[])
      const toolCalls = transcript.filter((item) => item.kind === 'tool').length
      let cost: number | undefined
      let contextPercent: number | undefined
      try {
        cost = session.getSessionStats().cost
      } catch {
        // No model turn yet.
      }
      try {
        const usage = session.getContextUsage()
        if (usage?.tokens != null && usage.contextWindow > 0) {
          contextPercent = Math.round((usage.tokens / usage.contextWindow) * 100)
        }
      } catch {
        // Same.
      }
      return {
        toolCalls,
        ...(cost === undefined ? {} : { cost }),
        ...(contextPercent === undefined ? {} : { contextPercent })
      }
    },

    transcript(): readonly TranscriptItem[] {
      return toTranscript(session.messages as unknown as StoredMessage[])
    },

    onActivity(listener: (now: string | undefined) => void): Unsubscribe {
      activityListeners.add(listener)
      return () => {
        activityListeners.delete(listener)
      }
    },

    dispose(): void {
      unsubscribe()
      activityListeners.clear()
      void session
        .abort()
        .catch(() => {})
        .then(() => {
          try {
            session.dispose()
          } catch {
            // Nobody is left to tell.
          }
        })
    }
  }
}

/**
 * What the node is doing right now, from π's own event stream; `null` means
 * this event says nothing about liveness.
 */
function liveness(
  event: Record<string, unknown>,
  inflight: Map<string, string>
): string | undefined | null {
  const type = String(event.type ?? '')
  if (type === 'message_update') {
    const message = event.message as { content?: unknown } | undefined
    const blocks = Array.isArray(message?.content)
      ? (message.content as Array<Record<string, unknown>>)
      : []
    const last = blocks[blocks.length - 1]
    const kind = String(last?.type ?? '').toLowerCase()
    if (kind.includes('tool')) return `composing ${String(last?.name ?? 'tool')} call…`
    if (kind.includes('thinking')) return 'thinking…'
    if (kind === 'text') return 'writing response…'
    return null
  }
  if (type === 'tool_execution_start') {
    const name = String(event.toolName ?? 'tool')
    inflight.set(String(event.toolCallId), name)
    return `running ${name}…`
  }
  if (type === 'tool_execution_end') {
    inflight.delete(String(event.toolCallId))
    const rest = [...inflight.values()]
    return rest.length > 0 ? `running ${rest[rest.length - 1]}…` : undefined
  }
  if (type === 'turn_end' || type === 'agent_end') {
    inflight.clear()
    return undefined
  }
  return null
}

function nodeTool(
  name: string,
  label: string,
  description: string,
  parameters: unknown,
  answer: (params: unknown) => string
): ToolDefinition {
  return {
    name,
    label,
    description,
    parameters: parameters as ToolDefinition['parameters'],
    async execute(_callId: string, params: unknown) {
      return { content: [{ type: 'text' as const, text: answer(params) }], details: {} }
    }
  }
}
