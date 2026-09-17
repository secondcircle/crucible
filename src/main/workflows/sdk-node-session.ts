import type {
  AgentSession,
  ToolDefinition
} from '@earendil-works/pi-coding-agent'
import type { ObservedCacheMiss } from '../../shared/agent/adapter'
import type { CacheMissFacts, TranscriptItem, Unsubscribe } from '../../shared/agent/port'
// Spelled with extensions so plain Node can load this module too.
import { composeSystemPrompt } from '../agent/system-prompt.ts'
import { monitorPiTools } from '../agent/monitor-pi-tools.ts'
import { shrinkingReadTool } from '../agent/shrink-images.ts'
import {
  scanCacheMisses,
  type CacheMissTrackerOptions,
  type DetectedCacheMiss
} from '../agent/cache-miss.ts'
import {
  branchHistory,
  entriesToScan,
  pathSeams,
  toCacheMessage,
  toTranscript,
  type StoredMessage
} from '../agent/sdk-transcript.ts'
import {
  askOnWarmCache,
  compactionExtension,
  storedCompactionOf
} from '../agent/sdk-compaction.ts'
import {
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionSettings
} from '../../shared/compaction/settings.ts'
import type { CompactionTrigger } from '../../shared/compaction/record.ts'
import { createCompactionWatch } from '../../shared/compaction/watch.ts'
import { RECENT_SPAN_TOKENS } from '../../shared/compaction/window.ts'
import { retentionInForce } from '../cache/retention.ts'
import { forPi, type LoadedSkill } from '../skills/service.ts'
import type {
  NodeSession,
  NodeSessionFactory,
  NodeSessionRequest,
  NodeSessionStats
} from './node-session.ts'

// A node is a fresh π session with two injected tools and no interactive
// user: in-memory session and settings managers, so nothing of π's state is
// read or written, and a full prompt override composed of the node's role
// and the standing prompt.

type Sdk = typeof import('@earendil-works/pi-coding-agent')

export interface SdkNodeSessionOptions {
  /** Appended to every node's role prompt, like every agent Crucible starts. */
  readonly standingPrompt: string
  /** A scratch agent dir for π's resource loader; nothing durable lives in it. */
  readonly agentDir: string
  // The machine-global compaction setting, read per decision. A node is an
  // agent loop like any other: same switch, same threshold, same idle rule.
  readonly compaction?: () => CompactionSettings
  /** A compaction nobody asked for and nobody is shown; the run log is the report. */
  readonly onCompactionFailure?: (cause: unknown) => void
}

export function createSdkNodeSessionFactory({
  standingPrompt,
  agentDir,
  compaction = () => DEFAULT_COMPACTION_SETTINGS,
  onCompactionFailure = () => {}
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
        // Named `read`, so it stands in for π's builtin — and only where the
        // node's list names one, since every custom tool joins the allowlist.
        ...(request.tools.includes('read') ? [shrinkingReadTool(pi, request.cwd)] : []),
        nodeTool(
          'complete_node',
          'Complete Node',
          "Declare this node's work finished. Only call when every required output file is " +
            'written. Include `verdict` when the task declares a verdict schema.',
          completeNodeParameters(request.verdictSchema),
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
        ),
        // Beside the two a node completes through, and for the same reason:
        // π's allowlist covers custom tools, so a node that lists only file
        // tools would otherwise lose the tools it waits through.
        ...(request.monitors === undefined ? [] : monitorPiTools(request.monitors))
      ]

      const skills = request.skills ?? []
      // Assigned once, below, and read late: the compaction hook is built
      // before the session it compacts exists.
      const held: { session?: AgentSession } = {}
      const live: { trigger: CompactionTrigger } = { trigger: 'threshold' }
      const settings = pi.SettingsManager.inMemory()
      // π's own auto-compaction is off here for the same reason it is off in a
      // session: Crucible decides when a loop compacts and writes what the
      // model reads afterwards.
      settings.applyOverrides({
        compaction: { enabled: false, keepRecentTokens: RECENT_SPAN_TOKENS }
      })
      const resourceLoader = new pi.DefaultResourceLoader({
        cwd: request.cwd,
        agentDir,
        settingsManager: settings,
        noExtensions: true,
        noPromptTemplates: true,
        // π's own folders stay unread; the node's skills are handed in whole
        // and never re-read, because a node is one task start to finish.
        noSkills: true,
        skillsOverride: () => ({ skills: forPi(skills), diagnostics: [] }),
        systemPromptOverride: () =>
          composeSystemPrompt({ role: request.rolePrompt, standing: standingPrompt }),
        appendSystemPromptOverride: () => [],
        extensionFactories: [
          compactionExtension({
            ask: (instruction, signal) => {
              const bound = held.session
              if (bound === undefined) throw new Error('this node has no conversation yet')
              return askOnWarmCache({
                session: bound,
                toLlm: pi.convertToLlm,
                complete: (model, context, options) =>
                  models.completeSimple(model, context, options)
              })(instruction, signal)
            },
            trigger: () => live.trigger,
            toItems: (messages) => toTranscript(messages),
            sizeOf: pi.estimateTokens,
            failed: onCompactionFailure,
            settled: () => {}
          })
        ]
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
        settingsManager: settings
      })
      held.session = session

      // A node's turns are watched for cache misses exactly as a session's
      // are: same mirror, same arithmetic, and the engine writes the entry.
      return wrapNodeSession(
        session,
        { skills, cwd: request.cwd },
        {
          listedCacheReadPerMillion: (provider, id) =>
            models.getModel(provider, id)?.cost.cacheRead,
          ...(request.onCacheMiss === undefined ? {} : { onCacheMiss: request.onCacheMiss })
        },
        {
          settings: compaction,
          begin: (trigger) => {
            live.trigger = trigger
          },
          entryToMessages: pi.sessionEntryToContextMessages as (
            entry: never
          ) => readonly StoredMessage[],
          onFailure: onCompactionFailure
        }
      )
    }
  }
}

interface CacheWatch extends CacheMissTrackerOptions {
  readonly onCacheMiss?: (miss: ObservedCacheMiss) => void
}

// The run view renders a node's transcript through the chat's own transcript
// code, so a skill read reads there exactly as it does in a session.
interface NodeSkills {
  readonly skills: readonly LoadedSkill[]
  readonly cwd: string
}

/**
 * The same number `toTranscript` would report, without building the
 * transcript: it pushes exactly one `tool` item per `toolResult` message,
 * unconditionally, so counting those messages is the same count. The engine
 * asks for this on every lull in a node's stream, and a long node's
 * transcript is megabytes.
 */
export function toolCallCount(messages: readonly StoredMessage[]): number {
  let count = 0
  for (const message of messages) if (message.role === 'toolResult') count += 1
  return count
}

// What a node needs to compact itself: the setting, somewhere to record which
// trigger fired, π's entry mapping for the transcript, and where a failure is
// reported. The rules themselves are the shared ones — there is no
// node-specific compaction.
interface NodeCompaction {
  readonly settings: () => CompactionSettings
  readonly begin: (trigger: CompactionTrigger) => void
  readonly entryToMessages: (entry: never) => readonly StoredMessage[]
  readonly onFailure: (cause: unknown) => void
}

/**
 * A π session as the engine's `NodeSession`: one delivery door, and the
 * compaction the same rules give every other agent loop Crucible runs.
 * Exported so the compaction's waits can be driven against a scripted session.
 */
export function wrapNodeSession(
  session: AgentSession,
  skills: NodeSkills,
  cache: CacheWatch,
  compaction: NodeCompaction
): NodeSession {
  const activityListeners = new Set<(now: string | undefined) => void>()
  const inflight = new Map<string, string>()
  const { retention } = retentionInForce()
  /** One conversation, so the watch holds exactly one entry. */
  const NODE = 'node'
  // The compaction running on this conversation, if one is, and the promise a
  // message waits on. π refuses a prompt outright while a compaction is in
  // progress, so without somewhere to hold the wait the engine's next message
  // — a monitor's wake, a run's report — would be thrown away and the node
  // would stall on a turn that said nothing.
  let compacting: Promise<void> | undefined
  // Between the engine deciding to speak and π reporting a stream, this is the
  // only sign the conversation is spoken for; without it a trigger could start
  // a compaction underneath a turn that is about to begin, and `compact()`
  // aborts whatever is running first.
  let prompting = false

  const watch = createCompactionWatch({
    settings: compaction.settings,
    retention,
    idle: () => !prompting && !session.isStreaming && compacting === undefined,
    compact: (_id, trigger) => {
      compaction.begin(trigger)
      // Never rejects: the watch is told when a compaction starts, and the
      // failure is the run log's to carry.
      compacting = (async () => {
        try {
          await session.compact()
        } catch (cause) {
          compaction.onFailure(cause)
        }
      })().finally(() => {
        compacting = undefined
      })
    }
  })

  /** Rounded to a hundredth of a cent, so no dollar figure carries a tail. */
  const round = (dollars: number): number => Math.round(dollars * 10_000) / 10_000

  // Detection per completed assistant message, against the conversation as it
  // stands without that message: π's own shape, and the run's node sessions
  // are short-lived and in memory, so the scan is over a handful of entries.
  function observe(message: StoredMessage): void {
    if (cache.onCacheMiss === undefined) return
    const scanned = toCacheMessage(message)
    if (scanned === undefined) return
    const entries = session.sessionManager
      .getEntries()
      .filter((entry) => (entry as { message?: unknown }).message !== message)
    const miss = scanCacheMisses(entriesToScan(entries), cache).tracker.observe(scanned)
    if (miss === undefined) return
    cache.onCacheMiss({
      provider: scanned.provider,
      model: scanned.model,
      ...(session.thinkingLevel === undefined ? {} : { thinkingLevel: session.thinkingLevel }),
      tokensRebilled: miss.missedTokens,
      dollarsRebilled: round(miss.missedCost),
      gapMs: miss.gapMs,
      changed: {
        model: miss.modelChanged ? 'yes' : 'no',
        // A node session is one conversation of one launch: nothing here
        // changes the level, jumps, compacts, or swaps the tools or the role
        // prompt under the agent.
        thinking: 'no',
        jump: 'no',
        compaction: 'no',
        tools: 'no',
        rolePrompt: 'no'
      }
    })
  }

  function seamFacts(miss: DetectedCacheMiss): CacheMissFacts {
    return {
      tokensRebilled: miss.missedTokens,
      dollarsRebilled: round(miss.missedCost),
      gapMs: miss.gapMs,
      modelChanged: miss.modelChanged ? 'yes' : 'no',
      thinkingChanged: 'no',
      jump: 'no',
      retention
    }
  }

  // The run view renders a node's transcript through the chat's own code, so
  // the seams have to be in it, placed the one way Crucible places them: over
  // the entries.
  function transcriptNow(): readonly TranscriptItem[] {
    // The branch rather than the model's view of it: a compaction changes what
    // the next request carries, and the run view goes on showing everything
    // the node did.
    const { messages, compactions } = branchHistory(
      session.sessionManager.getBranch(),
      compaction.entryToMessages,
      (details) => storedCompactionOf(details)?.record
    )
    const seams = new Map<number, CacheMissFacts>()
    for (const [at, miss] of pathSeams(session.sessionManager.getEntries(), messages, cache)) {
      seams.set(at, seamFacts(miss))
    }
    return toTranscript(messages, seams, skills, compactions)
  }

  // Every billed turn re-arms the idle clock and re-asks the size rules, from
  // the same facts a session reports across the port.
  function noteSize(message: StoredMessage): void {
    const at = (message as { timestamp?: unknown }).timestamp
    if (typeof at !== 'number') return
    const usage = session.getContextUsage()
    if (usage?.tokens == null) return
    watch.saw(NODE, {
      lastRequestAt: at,
      usedTokens: usage.tokens,
      contextWindow: usage.contextWindow
    })
  }

  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      observe(event.message as StoredMessage)
      noteSize(event.message as StoredMessage)
    }
    const now = liveness(event as Record<string, unknown>, inflight)
    if (now === null) return
    for (const listener of [...activityListeners]) listener(now)
  })

  return {
    async prompt(text: string): Promise<void> {
      // A compaction is not a failed turn: it is a "not yet". The message waits
      // for the rewrite rather than being refused and swallowed, exactly as a
      // session's send waits in the shell.
      prompting = true
      try {
        while (compacting !== undefined) await compacting
        // Model trouble never rejects the loop: a turn that failed ends and
        // the engine's nudge/stall machinery takes it from there.
        await session.prompt(text)
      } catch {
        // The session's own subscribers saw whatever there was to see.
      } finally {
        prompting = false
        // A trigger held back by this turn acts here, before the engine is told
        // the turn is over — so the engine's next message finds the compaction
        // already running and waits for it above, instead of racing it.
        watch.settled(NODE)
      }
    },

    async abort(): Promise<void> {
      // Whatever the conversation is doing stops, the rewrite included: a
      // release that left a compaction running would hold the next message
      // behind a wait nobody is waiting for any more.
      if (compacting !== undefined) session.abortCompaction()
      await session.abort().catch(() => {})
    },

    isStreaming(): boolean {
      return session.isStreaming
    },

    stats(): NodeSessionStats {
      const toolCalls = toolCallCount(session.messages as unknown as StoredMessage[])
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
      return transcriptNow()
    },

    onActivity(listener: (now: string | undefined) => void): Unsubscribe {
      activityListeners.add(listener)
      return () => {
        activityListeners.delete(listener)
      }
    },

    dispose(): void {
      unsubscribe()
      watch.dispose()
      activityListeners.clear()
      if (compacting !== undefined) session.abortCompaction()
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

/**
 * The complete_node parameter schema. A node that declares a verdict schema
 * gets it spliced in and marked required, so π's own argument validation
 * enforces it: the model sees a precise error naming the received arguments
 * on the very next token, instead of a vague engine rejection a turn later.
 * (Tool-call JSON is parsed by a repairing, never-fail parser upstream, so a
 * mangled call otherwise arrives as a plausible object with pieces missing.)
 */
export function completeNodeParameters(verdictSchema?: Record<string, unknown>): unknown {
  return {
    type: 'object',
    required: verdictSchema === undefined ? ['summary'] : ['summary', 'verdict'],
    properties: {
      summary: {
        type: 'string',
        description: 'One-paragraph summary of what was done.'
      },
      verdict:
        verdictSchema === undefined
          ? { description: 'Verdict matching the declared schema.' }
          : { description: 'Verdict matching the declared schema.', ...verdictSchema }
    }
  }
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
