import type { AssistantMessage, Context, Model, ThinkingLevel } from '@earendil-works/pi-ai'
import type { AgentSession, InlineExtension, SessionEntry } from '@earendil-works/pi-coding-agent'
import type { TranscriptItem } from '../../shared/agent/port'
import { planCompaction, settleCompaction } from '../../shared/compaction/compaction.ts'
import { COMPACTION_SYSTEM_PROMPT } from '../../shared/compaction/prompt.ts'
import type {
  CompactionRecord,
  CompactionTrigger
} from '../../shared/compaction/record.ts'
import { estimateTokens } from '../../shared/compaction/window.ts'
import type { StoredMessage } from './sdk-transcript.ts'

// Crucible's compaction, handed to π through the hook π offers for exactly
// this. π's own summarizer never runs: this returns the whole compaction
// content, so what lands in the session file is Crucible's summary and
// nothing of π's. The file keeps every original message — only what the next
// request carries changes.

export const COMPACTION_EXTENSION = 'crucible-compaction'

// Crucible's own data on π's compaction entry, under one key of the `details`
// slot π documents for extensions. It is what the transcript reads its facts
// from after a reload.
export const COMPACTION_DETAILS_KEY = 'crucible'

/** What a compaction entry carries home, beside the text the model reads. */
export interface StoredCompaction {
  readonly record: CompactionRecord
}

export interface CompactionDeps {
  // One model request that stands on its own: the instruction is its only
  // user message, and the conversation it summarizes is inside it as a
  // document. Answers with the model's text.
  readonly ask: (instruction: string, signal: AbortSignal) => Promise<string>
  /** What asked for this compaction; read at hook time, since π calls back. */
  readonly trigger: () => CompactionTrigger
  /** π's messages in the transcript's shape, which is what the document is rendered from. */
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

        // π hands over the previous compaction's summary itself; the span it
        // offers starts after that entry.
        const plan = planCompaction(preparation.previousSummary, deps.toItems(aged))

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
          deps.failed('The summary came back empty.')
          return { cancel: true }
        }

        // Nothing is kept behind the compaction, so what the window holds
        // afterwards is the compaction's own text and no more.
        const record: CompactionRecord = {
          trigger: deps.trigger(),
          tokensBefore: preparation.tokensBefore,
          tokensAfter: estimateTokens(settled.text)
        }
        const stored: StoredCompaction = { record }
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

// The compaction's own model request. It stands on its own: the same model
// the conversation runs on, a system prompt that says what is being asked, no
// tools, and one user message holding the conversation as a document with the
// instruction under it. It reads none of the provider's cached prefix, so a
// compaction bills the conversation once more; that is the price of a request
// that looks nothing like the agent's own turn. A build before this one
// appended the instruction to the live conversation to read the warm cache,
// and the provider's output classifier refused fourteen of sixteen such
// requests on one session as reproducing model output.
export function askAfresh(options: {
  readonly session: AgentSession
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
    const context = {
      systemPrompt: COMPACTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: instruction, timestamp: Date.now() }],
      tools: []
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

// The level the loop being compacted runs at: a summary of a day's work is
// worth the same thought the work got. Omitted where π omits it — thinking
// off, or a model that does not reason — because a level on such a request is
// a parameter the provider would reject or ignore.
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
 * the ask and what the model reads afterwards is the summary, then what
 * arrived after. A build before this one kept a 20k tail cut back to a turn
 * boundary, which in practice was 20k to 35k of the result and the largest
 * single part of it.
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

// π announces the compactions it starts itself — between two tool rounds of a
// turn, at the size `piCompactionSettings` armed, or on overflow — with the
// same events as the manual one `AgentSession.compact()` runs. The manual one
// is Crucible's own call and announces itself where it is made; these are the
// ones the caller learns of only here. π's `overflow` is the window edge by
// Crucible's names, and `threshold` is the threshold.
export function autoCompactionEvent(
  event: { readonly type: string; readonly reason?: string }
): { readonly kind: 'started'; readonly trigger: CompactionTrigger } | { readonly kind: 'ended' } | undefined {
  if (event.reason === 'manual') return undefined
  if (event.type === 'compaction_start') {
    return { kind: 'started', trigger: event.reason === 'overflow' ? 'windowEdge' : 'threshold' }
  }
  if (event.type === 'compaction_end') return { kind: 'ended' }
  return undefined
}

// The latest compaction on this branch, as Crucible wrote it. A compaction
// entry without Crucible's data is one π wrote before this build.
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
  // Older builds stored a `state` beside the record; it is not read.
  const { record } = held as { record?: unknown }
  if (typeof record !== 'object' || record === null) return undefined
  const { trigger, tokensBefore, tokensAfter } = record as Record<string, unknown>
  if (trigger !== 'threshold' && trigger !== 'windowEdge' && trigger !== 'idle') return undefined
  return {
    record: {
      trigger,
      tokensBefore: typeof tokensBefore === 'number' ? tokensBefore : 0,
      tokensAfter: typeof tokensAfter === 'number' ? tokensAfter : 0
    }
  }
}
