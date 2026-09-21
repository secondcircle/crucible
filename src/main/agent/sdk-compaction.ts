import type { AssistantMessage, Context, Model, ThinkingLevel } from '@earendil-works/pi-ai'
import type { AgentSession, InlineExtension, SessionEntry } from '@earendil-works/pi-coding-agent'
import type { TranscriptItem } from '../../shared/agent/port'
import {
  planCompaction,
  settleCompaction,
  type CompactionState
} from '../../shared/compaction/compaction.ts'
import type {
  CompactionRecord,
  CompactionTrigger
} from '../../shared/compaction/record.ts'
import { estimateTokens } from '../../shared/compaction/window.ts'
import type { StoredMessage } from './sdk-transcript.ts'

// Crucible's compaction, handed to π through the hook π offers for exactly
// this. π's own summarizer never runs: this returns the whole compaction
// content, so what lands in the session file is Crucible's trajectory summary
// and skeleton and nothing of π's. The file keeps every original message —
// only what the next request carries changes.

export const COMPACTION_EXTENSION = 'crucible-compaction'

// Crucible's own data on π's compaction entry, under one key of the `details`
// slot π documents for extensions. It is what the next compaction prunes and
// what the transcript reads its facts from after a reload.
export const COMPACTION_DETAILS_KEY = 'crucible'

/** What a compaction entry carries home, beside the text the model reads. */
export interface StoredCompaction {
  readonly record: CompactionRecord
  readonly state: CompactionState
}

export interface CompactionDeps {
  // One model request against the conversation exactly as it stands, so the
  // provider reads the prefix it already has cached and only the instruction
  // is new input. Answers with the model's text.
  readonly ask: (instruction: string, signal: AbortSignal) => Promise<string>
  /** What asked for this compaction; read at hook time, since π calls back. */
  readonly trigger: () => CompactionTrigger
  /** π's messages in the transcript's shape, which is what a skeleton is built from. */
  readonly toItems: (messages: readonly StoredMessage[]) => readonly TranscriptItem[]
  // π drops a hook that throws and falls back to its own summarizer, so a
  // failure is reported here and the compaction cancelled instead.
  readonly failed: (message: string) => void
  // The compaction as it was written, where the caller has something to do
  // with it as it lands — a session announces it across the port. Everything
  // durable about it is on π's entry either way, so a caller that reads it
  // back from there wants none of this.
  readonly settled?: (stored: StoredCompaction, text: string) => void
}

// What π's own compaction is told in every loop Crucible starts. Off, because
// Crucible decides when a conversation compacts and writes what the model
// reads afterwards; and a zero tail, because nothing of the compacted span is
// kept verbatim. π still finds a cut point from that number, and the hook
// below ages out whatever π would have kept.
export const PI_COMPACTION_SETTINGS = { enabled: false, keepRecentTokens: 0 } as const

// What the compaction entry names as its first kept entry. Nothing is kept:
// the entry stands for everything up to the moment the compaction was asked
// for, and the model's view is the entry and then what arrived after it. π
// reads an id that matches no earlier entry exactly that way, both when it
// builds the model's context and when it finds the next compaction's start.
export const NOTHING_KEPT = 'crucible:nothing-kept'

export function compactionExtension(deps: CompactionDeps): InlineExtension {
  return {
    name: COMPACTION_EXTENSION,
    hidden: true,
    factory: (pi) => {
      pi.on('session_before_compact', async (event) => {
        const { preparation, branchEntries, signal } = event
        const aged = everythingSince(preparation, branchEntries)
        if (aged.length === 0) {
          deps.failed('There is nothing in this conversation to compact yet.')
          return { cancel: true }
        }

        const plan = planCompaction(previousCompaction(branchEntries)?.state, deps.toItems(aged))

        let reply: string
        try {
          reply = await deps.ask(plan.instruction, signal)
        } catch (thrown) {
          deps.failed(thrown instanceof Error ? thrown.message : String(thrown))
          return { cancel: true }
        }
        if (signal.aborted) return { cancel: true }

        const settled = settleCompaction(plan, reply)
        if (settled === undefined) {
          deps.failed('The trajectory summary came back empty or cut short.')
          return { cancel: true }
        }

        // Nothing is kept behind the compaction, so what the window holds
        // afterwards is the compaction's own text and no more.
        const record: CompactionRecord = {
          trigger: deps.trigger(),
          tokensBefore: preparation.tokensBefore,
          tokensAfter: estimateTokens(settled.text)
        }
        const stored: StoredCompaction = { record, state: settled.state }
        deps.settled?.(stored, settled.text)

        return {
          compaction: {
            summary: settled.text,
            firstKeptEntryId: NOTHING_KEPT,
            tokensBefore: preparation.tokensBefore,
            details: { [COMPACTION_DETAILS_KEY]: stored }
          }
        }
      })
    }
  }
}

// The compaction's own model request. It is the conversation as it stands —
// same system prompt, same tools, same messages, same thinking level — with
// the instruction appended, so the provider reads the prefix it is already
// holding instead of re-billing it. That is the whole reason the idle
// compaction fires with the cache still warm rather than after it has lapsed,
// and why the conversation is not serialized into a blob first.
export function askOnWarmCache(options: {
  readonly session: AgentSession
  readonly toLlm: (messages: never) => unknown[]
  readonly complete: (
    model: Model<never>,
    context: Context,
    options: { readonly signal: AbortSignal; readonly reasoning?: ThinkingLevel }
  ) => Promise<AssistantMessage>
}): CompactionDeps['ask'] {
  return async (instruction, signal) => {
    const { session } = options
    const model = session.model
    if (model === undefined) throw new Error('This conversation has no model to compact with.')
    // The agent's own list, in the agent's own order: π builds a turn's tools
    // block from that list, and the block is a cache breakpoint, so a block
    // that agrees on contents but not on order re-bills the whole prefix.
    const defined = new Map(session.getAllTools().map((tool) => [tool.name, tool]))
    const tools = session
      .getActiveToolNames()
      .map((name) => defined.get(name))
      .filter((tool) => tool !== undefined)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }))
    const context = {
      systemPrompt: session.systemPrompt,
      messages: [
        ...options.toLlm([...session.messages] as never),
        { role: 'user', content: instruction }
      ],
      tools
    } as unknown as Context
    const answer = await options.complete(model as unknown as Model<never>, context, {
      signal,
      ...reasoningOf(session)
    })
    return textOf(wholeReply(answer))
  }
}

// π's `complete` does not throw for a reply the provider cut: a stream that
// errored, ran out of output room or was aborted comes back as a message with
// that stop reason and whatever text had arrived. For a turn that is the
// right shape — the loop reads the reason and retries. For a compaction it
// is a partial account about to replace a whole one, so anything but a
// finished reply is refused here, naming the reason, and the compaction is
// cancelled with the conversation as it was. Four idle compactions in one
// session landed accounts cut mid-word before this refused them.
export function wholeReply(answer: AssistantMessage): AssistantMessage {
  if (answer.stopReason === 'stop') return answer
  const detail = answer.errorMessage === undefined ? '' : `: ${answer.errorMessage}`
  throw new Error(
    `The compaction's model reply ended with stop reason "${answer.stopReason}"${detail}.`
  )
}

// The level the loop being compacted runs at, which is part of what makes the
// request land on the prefix the provider is holding: a request at another
// level is a different prompt and re-bills the conversation this one exists
// to save. Omitted where π omits it — thinking off, or a model that does not
// reason — because a level on such a request is a parameter the provider
// would reject or ignore.
function reasoningOf(session: AgentSession): { readonly reasoning?: ThinkingLevel } {
  const level = session.thinkingLevel
  if (session.model?.reasoning !== true || level === undefined || level === 'off') return {}
  return { reasoning: level }
}

function textOf(message: AssistantMessage): string {
  return (message.content ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
}

/**
 * Everything the compacted span holds, in order: what π offered to summarize,
 * the prefix of any turn π's cut split, and whatever π would have kept behind
 * the cut. All of it ages out. A compaction is asked for between turns, with
 * anything sent meanwhile waiting on it, so the span runs to the moment of
 * the ask and what the model reads afterwards is the account and the
 * skeleton, then what arrived after. A build before this one kept a 20k tail
 * cut back to a turn boundary, which in practice was 20k to 35k of the
 * result and the largest single part of it.
 */
export function everythingSince(
  preparation: {
    readonly firstKeptEntryId: string
    readonly messagesToSummarize: readonly StoredMessage[]
    readonly turnPrefixMessages: readonly StoredMessage[]
  },
  entries: readonly SessionEntry[]
): readonly StoredMessage[] {
  return [
    ...preparation.messagesToSummarize,
    ...preparation.turnPrefixMessages,
    ...messagesFrom(entries, preparation.firstKeptEntryId)
  ]
}

/** The messages π would have kept: every one from the first kept entry on. */
function messagesFrom(
  entries: readonly SessionEntry[],
  keptFrom: string
): readonly StoredMessage[] {
  const at = entries.findIndex((entry) => entry.id === keptFrom)
  if (at === -1) return []
  return entries
    .slice(at)
    .map((entry) => (entry as { message?: StoredMessage }).message)
    .filter((message): message is StoredMessage => message !== undefined)
}

// The latest compaction on this branch, as Crucible wrote it. A compaction
// entry without Crucible's data is one π wrote before this build, and its
// skeleton is simply not there to carry forward.
export function previousCompaction(
  entries: readonly { readonly type?: unknown; readonly details?: unknown }[]
): StoredCompaction | undefined {
  for (let at = entries.length - 1; at >= 0; at -= 1) {
    const entry = entries[at]
    if (entry?.type !== 'compaction') continue
    return storedCompactionOf(entry.details)
  }
  return undefined
}

/** π's `details` read defensively: a file outlives the build that wrote it. */
export function storedCompactionOf(details: unknown): StoredCompaction | undefined {
  if (typeof details !== 'object' || details === null) return undefined
  const held = (details as Record<string, unknown>)[COMPACTION_DETAILS_KEY]
  if (typeof held !== 'object' || held === null) return undefined
  const { record, state } = held as { record?: unknown; state?: unknown }
  if (typeof record !== 'object' || record === null) return undefined
  const { trigger, tokensBefore, tokensAfter } = record as Record<string, unknown>
  if (trigger !== 'threshold' && trigger !== 'windowEdge' && trigger !== 'idle') return undefined
  const skeleton = (state as { skeleton?: unknown } | undefined)?.skeleton
  return {
    record: {
      trigger,
      tokensBefore: typeof tokensBefore === 'number' ? tokensBefore : 0,
      tokensAfter: typeof tokensAfter === 'number' ? tokensAfter : 0
    },
    state: { skeleton: Array.isArray(skeleton) ? skeleton : [] }
  }
}
