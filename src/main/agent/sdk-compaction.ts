import type { AssistantMessage, Context, Model } from '@earendil-works/pi-ai'
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
  /** π's own per-message estimate, so the window after is counted π's way. */
  readonly sizeOf: (message: StoredMessage) => number
  // π drops a hook that throws and falls back to its own summarizer, so a
  // failure is reported here and the compaction cancelled instead.
  readonly failed: (message: string) => void
  /** The compaction as it was written, for the transcript and the port. */
  readonly settled: (stored: StoredCompaction, text: string) => void
}

export function compactionExtension(deps: CompactionDeps): InlineExtension {
  return {
    name: COMPACTION_EXTENSION,
    hidden: true,
    factory: (pi) => {
      pi.on('session_before_compact', async (event) => {
        const { preparation, branchEntries, signal } = event
        const cut = cutAtUserBoundary(preparation, branchEntries)
        if (cut.aged.length === 0) {
          // One turn is the whole conversation, so there is no boundary to cut
          // at and nothing to move out of the window.
          deps.failed('There is nothing in this conversation to compact yet.')
          return { cancel: true }
        }
        const { keptFrom, aged } = cut

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
          deps.failed('The trajectory summary came back empty.')
          return { cancel: true }
        }

        const record: CompactionRecord = {
          trigger: deps.trigger(),
          tokensBefore: preparation.tokensBefore,
          tokensAfter:
            estimateTokens(settled.text) + keptTokens(branchEntries, keptFrom, deps.sizeOf)
        }
        const stored: StoredCompaction = { record, state: settled.state }
        deps.settled(stored, settled.text)

        return {
          compaction: {
            summary: settled.text,
            firstKeptEntryId: keptFrom,
            tokensBefore: preparation.tokensBefore,
            details: { [COMPACTION_DETAILS_KEY]: stored }
          }
        }
      })
    }
  }
}

// The compaction's own model request. It is the conversation as it stands —
// same system prompt, same tools, same messages — with the instruction
// appended, so the provider reads the prefix it is already holding instead of
// re-billing it. That is the whole reason the idle compaction fires with the
// cache still warm rather than after it has lapsed, and why the conversation
// is not serialized into a blob first.
export function askOnWarmCache(options: {
  readonly session: AgentSession
  readonly toLlm: (messages: never) => unknown[]
  readonly complete: (
    model: Model<never>,
    context: Context,
    options: { readonly signal: AbortSignal }
  ) => Promise<AssistantMessage>
}): CompactionDeps['ask'] {
  return async (instruction, signal) => {
    const { session } = options
    const model = session.model
    if (model === undefined) throw new Error('This conversation has no model to compact with.')
    const active = new Set(session.getActiveToolNames())
    const tools = session
      .getAllTools()
      .filter((tool) => active.has(tool.name))
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
    const answer = await options.complete(model as unknown as Model<never>, context, { signal })
    return textOf(answer)
  }
}

function textOf(message: AssistantMessage): string {
  return (message.content ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
}

/**
 * Where the recent span starts, and what ages out behind it.
 *
 * π cuts inside a turn when that one turn is larger than the recent span. The
 * cut moves back to the turn's own first message, so the span always starts at
 * a user message and no turn is half verbatim and half skeleton. Where that
 * message cannot be placed in the branch, π's own cut stands and the turn's
 * prefix ages out with everything before it: the boundary is worth honoring,
 * losing a stretch of the conversation from the window is not.
 */
export function cutAtUserBoundary(
  preparation: {
    readonly isSplitTurn: boolean
    readonly firstKeptEntryId: string
    readonly messagesToSummarize: readonly StoredMessage[]
    readonly turnPrefixMessages: readonly StoredMessage[]
  },
  entries: readonly SessionEntry[]
): { readonly keptFrom: string; readonly aged: readonly StoredMessage[] } {
  if (!preparation.isSplitTurn) {
    return { keptFrom: preparation.firstKeptEntryId, aged: preparation.messagesToSummarize }
  }
  const turnStart = entryIdOf(entries, preparation.turnPrefixMessages[0])
  if (turnStart !== undefined) {
    return { keptFrom: turnStart, aged: preparation.messagesToSummarize }
  }
  return {
    keptFrom: preparation.firstKeptEntryId,
    aged: [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]
  }
}

/** The entry carrying this exact message, by identity: π hands out the object. */
function entryIdOf(entries: readonly SessionEntry[], message: unknown): string | undefined {
  if (message === undefined) return undefined
  return entries.find((entry) => (entry as { message?: unknown }).message === message)?.id
}

// What the window holds behind the compaction: every message from the first
// kept entry on. Estimated rather than measured, because nothing has been
// sent yet.
function keptTokens(
  entries: readonly SessionEntry[],
  keptFrom: string,
  sizeOf: (message: StoredMessage) => number
): number {
  const at = entries.findIndex((entry) => entry.id === keptFrom)
  if (at === -1) return 0
  let total = 0
  for (const entry of entries.slice(at)) {
    const message = (entry as { message?: StoredMessage }).message
    if (message !== undefined) total += sizeOf(message)
  }
  return total
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
