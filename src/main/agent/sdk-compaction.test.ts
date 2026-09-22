// @vitest-environment node
//
// π's compaction entry is where a compaction survives a relaunch, and its
// `details` slot is a file this build will read back years from now. Read
// defensively: an entry π wrote itself, or one an older Crucible wrote, must
// leave the transcript standing rather than throwing on open.
import { describe, expect, it } from 'vitest'
import type { AgentSession, SessionEntry } from '@earendil-works/pi-coding-agent'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { TranscriptItem } from '../../shared/agent/port'
import { COMPACTION_SYSTEM_PROMPT } from '../../shared/compaction/prompt'
import {
  COMPACTION_DETAILS_KEY,
  askAfresh,
  autoCompactionEvent,
  compactionExtension,
  everythingSince,
  NOTHING_KEPT,
  previousCompaction,
  storedCompactionOf,
  wholeReply,
  type CompactionDeps,
  type StoredCompaction
} from './sdk-compaction'
import type { StoredMessage } from './sdk-transcript'

const WRITTEN: StoredCompaction = {
  record: { trigger: 'idle', tokensBefore: 214_000, tokensAfter: 48_000 }
}

const entry = (details: unknown): { type: string; details?: unknown } => ({
  type: 'compaction',
  details
})

describe('reading Crucible’s data off a π compaction entry', () => {
  it('reads back what it wrote', () => {
    expect(storedCompactionOf({ [COMPACTION_DETAILS_KEY]: WRITTEN })).toEqual(WRITTEN)
  })

  it('answers with nothing for a compaction π wrote itself', () => {
    expect(storedCompactionOf({ readFiles: [], modifiedFiles: [] })).toBeUndefined()
    expect(storedCompactionOf(undefined)).toBeUndefined()
    expect(storedCompactionOf('nonsense')).toBeUndefined()
  })

  it('refuses a trigger this build does not know, rather than showing one', () => {
    expect(
      storedCompactionOf({
        [COMPACTION_DETAILS_KEY]: {
          record: { trigger: 'whatever' },
          state: { skeleton: [] }
        }
      })
    ).toBeUndefined()
  })

  it('reads a record missing its numbers as zeroes', () => {
    expect(
      storedCompactionOf({
        [COMPACTION_DETAILS_KEY]: { record: { trigger: 'threshold' } }
      })
    ).toEqual({
      record: { trigger: 'threshold', tokensBefore: 0, tokensAfter: 0 }
    })
  })

  // A build before this one stored a skeleton beside the record. Read past.
  it('ignores the state an older build stored beside the record', () => {
    expect(
      storedCompactionOf({
        [COMPACTION_DETAILS_KEY]: {
          record: { trigger: 'threshold', tokensBefore: 1, tokensAfter: 1 },
          state: { skeleton: [{ kind: 'user', text: 'old' }] }
        }
      })
    ).toEqual({ record: { trigger: 'threshold', tokensBefore: 1, tokensAfter: 1 } })
  })
})

describe('the compaction a branch is standing on', () => {
  it('is the latest one, because summaries are rewritten and never stacked', () => {
    const older: StoredCompaction = {
      record: { trigger: 'threshold', tokensBefore: 10, tokensAfter: 5 }
    }
    const entries = [
      { type: 'message' },
      entry({ [COMPACTION_DETAILS_KEY]: older }),
      { type: 'message' },
      entry({ [COMPACTION_DETAILS_KEY]: WRITTEN })
    ]
    expect(previousCompaction(entries)).toEqual(WRITTEN)
  })

  it('is nothing at all on a branch that has never compacted', () => {
    expect(previousCompaction([{ type: 'message' }, { type: 'branch_summary' }])).toBeUndefined()
  })
})

// The request stands on its own: same model, the compaction's own system
// prompt, no tools, one user message. It reads nothing of the agent's own
// prefix, by design: the request that did was the one the provider's output
// classifier kept refusing.
describe('the compaction’s own model request', () => {
  const sessionAt = (thinkingLevel: string | undefined, reasoning = true): AgentSession =>
    ({
      model: { id: 'claude-probe', provider: 'anthropic', reasoning },
      thinkingLevel,
      systemPrompt: 'the session’s own system prompt',
      messages: [{ role: 'user', content: 'the conversation so far' }],
      getActiveToolNames: () => ['bash', 'read'],
      getAllTools: () => []
    }) as unknown as AgentSession

  interface Seen {
    readonly options: { readonly reasoning?: string }
    readonly context: {
      readonly systemPrompt?: string
      readonly messages: { role: string; content: unknown }[]
      readonly tools?: unknown[]
    }
  }

  async function askedWith(session: AgentSession): Promise<Seen> {
    let seen: Seen | undefined
    const ask = askAfresh({
      session,
      complete: async (_model, context, options) => {
        seen = { options, context: context as unknown as Seen['context'] }
        return {
          content: [{ type: 'text', text: 'the summary' }],
          stopReason: 'stop'
        } as AssistantMessage
      }
    })
    await ask('compact this', new AbortController().signal)
    if (seen === undefined) throw new Error('the request was supposed to be made')
    return seen
  }

  it('carries the instruction as its only message, under its own system prompt', async () => {
    const { context } = await askedWith(sessionAt('high'))
    expect(context.systemPrompt).toBe(COMPACTION_SYSTEM_PROMPT)
    expect(context.messages.map((message) => message.content)).toEqual(['compact this'])
    expect(context.tools).toEqual([])
  })

  it('runs at the thinking level the loop being compacted runs at', async () => {
    expect((await askedWith(sessionAt('high'))).options.reasoning).toBe('high')
  })

  it('carries no level where the loop thinks not at all', async () => {
    expect((await askedWith(sessionAt('off'))).options).not.toHaveProperty('reasoning')
  })

  it('carries no level on a model that does not reason', async () => {
    expect((await askedWith(sessionAt('high', false))).options).not.toHaveProperty('reasoning')
  })

  // Text up to where the provider stopped reads as a summary and would settle
  // as one, with its ending cut mid-sentence.
  it('refuses a reply the provider cut off', async () => {
    const ask = askAfresh({
      session: sessionAt('high'),
      complete: async () =>
        ({
          stopReason: 'length',
          content: [{ type: 'text', text: 'half a summ' }]
        }) as AssistantMessage
    })
    await expect(ask('compact this', new AbortController().signal)).rejects.toThrow(
      'stop reason "length"'
    )
  })
})

// π's `complete` hands back a cut reply as a message, not a throw: the stop
// reason says the stream errored, ran out of room or was aborted, and the
// content is whatever had arrived. A compaction that took one wrote a
// fragment over a whole account.
describe('the compaction’s model reply', () => {
  const replied = (stopReason: string, errorMessage?: string): AssistantMessage =>
    ({
      content: [{ type: 'text', text: 'Where we are, cut mid-wo' }],
      stopReason,
      ...(errorMessage === undefined ? {} : { errorMessage })
    }) as AssistantMessage

  it('is taken whole when the model finished', () => {
    expect(wholeReply(replied('stop'))).toEqual(replied('stop'))
  })

  it.each(['error', 'length', 'aborted'])('is refused when it ended with %s', (reason) => {
    expect(() => wholeReply(replied(reason))).toThrow(`stop reason "${reason}"`)
  })

  it('names the provider’s own reason, so the log can say why', () => {
    expect(() => wholeReply(replied('error', 'overloaded_error'))).toThrow('overloaded_error')
  })

  it('is refused by the request itself, before any text is read', async () => {
    const ask = askAfresh({
      session: {
        model: { id: 'm', provider: 'anthropic', reasoning: false }
      } as unknown as AgentSession,
      complete: async () => replied('error', 'stream reset')
    })
    await expect(ask('compact', new AbortController().signal)).rejects.toThrow('stream reset')
  })
})

// The hook is where a reply becomes the window. Driven here with π's shape
// faked, because nothing else exercises what it does with a bad reply or
// with the previous summary π hands it.
describe('the compaction hook', () => {
  type Hook = (event: {
    preparation: {
      isSplitTurn: boolean
      firstKeptEntryId: string
      messagesToSummarize: StoredMessage[]
      turnPrefixMessages: StoredMessage[]
      tokensBefore: number
      previousSummary?: string
    }
    branchEntries: SessionEntry[]
    signal: AbortSignal
  }) => Promise<
    { cancel?: boolean; compaction?: { summary: string; details: unknown } } | undefined
  >

  const user = (text: string): StoredMessage =>
    ({ role: 'user', content: text, timestamp: 0 }) as StoredMessage

  function hookWith(
    reply: string
  ): { hook: Hook; failures: string[]; settled: StoredCompaction[]; asked: string[] } {
    const failures: string[] = []
    const settled: StoredCompaction[] = []
    const asked: string[] = []
    const deps: CompactionDeps = {
      ask: async (instruction) => {
        asked.push(instruction)
        return reply
      },
      trigger: () => 'idle',
      toItems: (messages) =>
        messages.map((message): TranscriptItem => ({
          kind: 'user',
          text: String((message as { content: unknown }).content)
        })),
      failed: (message) => failures.push(message),
      settled: (stored) => settled.push(stored)
    }
    let hook: Hook | undefined
    const extension = compactionExtension(deps)
    if (typeof extension === 'function') throw new Error('the extension is supposed to be named')
    extension.factory({
      on: (_name: string, handler: Hook) => {
        hook = handler
      }
    } as never)
    if (hook === undefined) throw new Error('the hook was supposed to be registered')
    return { failures, settled, asked, hook }
  }

  const aged = {
    preparation: {
      isSplitTurn: false,
      firstKeptEntryId: 'k1',
      messagesToSummarize: [user('the ask'), user('a follow-up')],
      turnPrefixMessages: [],
      tokensBefore: 200_000
    },
    branchEntries: [],
    signal: new AbortController().signal
  }

  // Answer 2 of the review that reshaped this: everything up to the ask is
  // summarized, and what the model reads afterwards is the compaction and
  // then what arrived after it. No tail of the compacted span stays verbatim.
  it('keeps nothing of the compacted span verbatim', async () => {
    const { hook } = hookWith('Standing here.')
    const result = await hook(aged)
    expect(result?.compaction).toMatchObject({
      firstKeptEntryId: NOTHING_KEPT
    })
    const stored = (result?.compaction?.details as Record<string, StoredCompaction>)[
      COMPACTION_DETAILS_KEY
    ]
    // What the window holds afterwards is the compaction's text and no more.
    expect(stored?.record.tokensAfter).toBe(
      Math.ceil((result?.compaction?.summary.length ?? 0) / 4)
    )
  })

  it('cancels, saying so, when the model wrote nothing', async () => {
    const { hook, failures, settled } = hookWith('  \n')
    expect(await hook(aged)).toEqual({ cancel: true })
    expect(failures).toEqual(['The summary came back empty.'])
    expect(settled).toEqual([])
  })

  // π hands over the previous compaction's own summary, and the span it
  // offers starts after that entry. The summary goes into the document so
  // the next one is written over both.
  it('summarizes the previous summary together with what followed it', async () => {
    const { hook, asked } = hookWith('Standing further along.')
    await hook({
      ...aged,
      preparation: { ...aged.preparation, previousSummary: 'Standing here.' }
    })
    const instruction = asked[0] ?? ''
    expect(instruction).toContain('Standing here.')
    expect(instruction).toContain('the ask')
    expect(instruction.indexOf('Standing here.')).toBeLessThan(instruction.indexOf('the ask'))
  })

  it('writes the summary as the whole of what the model reads afterwards', async () => {
    const { hook } = hookWith('Standing here.')
    const result = await hook(aged)
    expect(result?.compaction?.summary).toBe('Standing here.')
  })
})

// A workflow node is one long turn, and a session's turn can run for an hour
// of tool calls: π's own check between tool rounds is the one place a
// compaction lands while an agent works, and π announces those with the same
// events as the manual one. The manual one announces itself where it is
// called, so it is not announced twice.
describe('a compaction π started on its own', () => {
  it('opens as the threshold, or as the window edge on overflow', () => {
    expect(autoCompactionEvent({ type: 'compaction_start', reason: 'threshold' })).toEqual({
      kind: 'started',
      trigger: 'threshold'
    })
    expect(autoCompactionEvent({ type: 'compaction_start', reason: 'overflow' })).toEqual({
      kind: 'started',
      trigger: 'windowEdge'
    })
  })

  it('closes with the end event', () => {
    expect(autoCompactionEvent({ type: 'compaction_end', reason: 'threshold' })).toEqual({
      kind: 'ended'
    })
  })

  it('is silent for the manual one and for every other event', () => {
    expect(autoCompactionEvent({ type: 'compaction_start', reason: 'manual' })).toBeUndefined()
    expect(autoCompactionEvent({ type: 'compaction_end', reason: 'manual' })).toBeUndefined()
    expect(autoCompactionEvent({ type: 'message_end' })).toBeUndefined()
  })
})

// π offers what it would summarize and keeps the rest behind its cut; all of
// it ages out, in the order it happened.
describe('what a compaction ages out', () => {
  const older = { role: 'user', content: 'older' } as StoredMessage
  const user = {
    role: 'user',
    content: 'the turn’s first message'
  } as StoredMessage
  const call = { role: 'assistant', content: [] } as unknown as StoredMessage
  const entries = [
    { id: 'e1', message: older },
    { id: 'e2', message: user },
    { id: 'e3', message: call }
  ] as unknown as SessionEntry[]

  it('is everything: what π offered and what π would have kept', () => {
    expect(
      everythingSince(
        {
          firstKeptEntryId: 'e2',
          messagesToSummarize: [older],
          turnPrefixMessages: []
        },
        entries
      )
    ).toEqual([older, user, call])
  })

  it('includes the prefix of a turn π’s cut split, before what π kept', () => {
    expect(
      everythingSince(
        {
          firstKeptEntryId: 'e3',
          messagesToSummarize: [older],
          turnPrefixMessages: [user]
        },
        entries
      )
    ).toEqual([older, user, call])
  })

  // A previous compaction of this build named no kept entry, so π's start
  // point for the next one is the entry after it and its cut is in the same
  // place; nothing is counted twice.
  it('adds nothing where π’s kept entry is not on the branch', () => {
    expect(
      everythingSince(
        {
          firstKeptEntryId: NOTHING_KEPT,
          messagesToSummarize: [older, user, call],
          turnPrefixMessages: []
        },
        entries
      )
    ).toEqual([older, user, call])
  })
})
