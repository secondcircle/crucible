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
import { RUN_MESSAGE_PREFIX } from '../../shared/workflows/run'
import {
  COMPACTION_DETAILS_KEY,
  askOnWarmCache,
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
  record: { trigger: 'idle', tokensBefore: 214_000, tokensAfter: 48_000 },
  state: { skeleton: [{ kind: 'user', text: 'the ask' }] }
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

  it('reads a record missing its numbers as zeroes and keeps the skeleton', () => {
    expect(
      storedCompactionOf({
        [COMPACTION_DETAILS_KEY]: { record: { trigger: 'threshold' } }
      })
    ).toEqual({
      record: { trigger: 'threshold', tokensBefore: 0, tokensAfter: 0 },
      state: { skeleton: [] }
    })
  })
})

describe('the compaction a branch is standing on', () => {
  it('is the latest one, because summaries are rewritten and never stacked', () => {
    const older: StoredCompaction = {
      record: { trigger: 'threshold', tokensBefore: 10, tokensAfter: 5 },
      state: { skeleton: [] }
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

// Q6: "Same model and same thinking level as the loop being compacted." The
// request only reads the cached prefix if it is the same prompt the provider
// is holding, and a thinking change is a cache miss in Crucible's own model of
// one (`CacheMissFacts.thinkingChanged`). π carries the level the same way.
describe('the compaction’s own model request', () => {
  const sessionAt = (
    thinkingLevel: string | undefined,
    reasoning = true,
    tools: { active: string[]; all: string[] } = { active: [], all: [] }
  ): AgentSession =>
    ({
      model: { id: 'claude-probe', provider: 'anthropic', reasoning },
      thinkingLevel,
      systemPrompt: 'the session’s own system prompt',
      messages: [{ role: 'user', content: 'the conversation so far' }],
      getActiveToolNames: () => tools.active,
      getAllTools: () => tools.all.map((name) => ({ name, description: name, parameters: {} }))
    }) as unknown as AgentSession

  async function askedWith(session: AgentSession): Promise<{
    readonly options: { readonly reasoning?: string }
    readonly context: { readonly tools?: { name: string }[] }
  }> {
    let seen:
      | {
          options: { readonly reasoning?: string }
          context: { readonly tools?: { name: string }[] }
        }
      | undefined
    const ask = askOnWarmCache({
      session,
      toLlm: (messages) => [...(messages as unknown as unknown[])],
      complete: async (_model, context, options) => {
        seen = {
          options,
          context: context as unknown as { tools?: { name: string }[] }
        }
        return {
          content: [{ type: 'text', text: '<trajectory>x</trajectory>' }],
          stopReason: 'stop'
        } as AssistantMessage
      }
    })
    await ask('compact this', new AbortController().signal)
    if (seen === undefined) throw new Error('the request was supposed to be made')
    return seen
  }

  it('runs at the thinking level the loop being compacted runs at', async () => {
    expect((await askedWith(sessionAt('high'))).options.reasoning).toBe('high')
  })

  it('carries no level where the loop thinks not at all', async () => {
    expect((await askedWith(sessionAt('off'))).options).not.toHaveProperty('reasoning')
  })

  it('carries no level on a model that does not reason', async () => {
    expect((await askedWith(sessionAt('high', false))).options).not.toHaveProperty('reasoning')
  })

  // The tools block is a cache breakpoint: same tools in another order is
  // another prefix, and the whole conversation is re-billed.
  it('carries the agent’s own tools, in the agent’s own order', async () => {
    const session = sessionAt('high', true, {
      active: ['bash', 'read', 'write'],
      all: ['read', 'write', 'bash', 'not_mounted']
    })

    expect((await askedWith(session)).context.tools?.map((tool) => tool.name)).toEqual([
      'bash',
      'read',
      'write'
    ])
  })
})

// π's `complete` hands back a cut reply as a message, not a throw: the stop
// reason says the stream errored, ran out of room or was aborted, and the
// content is whatever had arrived. A compaction that took one wrote a
// fragment over a whole account.
describe('the compaction’s model reply', () => {
  const replied = (stopReason: string, errorMessage?: string): AssistantMessage =>
    ({
      content: [{ type: 'text', text: '<trajectory>Where we are, cut mid-wo' }],
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
    const ask = askOnWarmCache({
      session: {
        model: { id: 'm', provider: 'anthropic', reasoning: false },
        systemPrompt: '',
        messages: [],
        getActiveToolNames: () => [],
        getAllTools: () => []
      } as unknown as AgentSession,
      toLlm: () => [],
      complete: async () => replied('error', 'stream reset')
    })
    await expect(ask('compact', new AbortController().signal)).rejects.toThrow('stream reset')
  })
})

// The hook is where a reply becomes the window. Driven here with π's shape
// faked, because nothing else exercises what it does with a bad reply or
// with the skeleton it was handed.
describe('the compaction hook', () => {
  type Hook = (event: {
    preparation: {
      isSplitTurn: boolean
      firstKeptEntryId: string
      messagesToSummarize: StoredMessage[]
      turnPrefixMessages: StoredMessage[]
      tokensBefore: number
    }
    branchEntries: SessionEntry[]
    signal: AbortSignal
  }) => Promise<
    { cancel?: boolean; compaction?: { summary: string; details: unknown } } | undefined
  >

  const user = (text: string): StoredMessage =>
    ({ role: 'user', content: text, timestamp: 0 }) as StoredMessage

  function hookWith(
    reply: string,
    previous?: StoredCompaction
  ): { hook: Hook; failures: string[]; settled: StoredCompaction[] } {
    const failures: string[] = []
    const settled: StoredCompaction[] = []
    const deps: CompactionDeps = {
      ask: async () => reply,
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
    const entries: SessionEntry[] =
      previous === undefined
        ? []
        : [
            {
              type: 'compaction',
              id: 'c1',
              details: { [COMPACTION_DETAILS_KEY]: previous }
            } as never
          ]
    const registered = hook
    return {
      failures,
      settled,
      hook: (event) =>
        registered({
          ...event,
          branchEntries: [...entries, ...event.branchEntries]
        })
    }
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
    const { hook } = hookWith('<trajectory>Standing here.</trajectory><strike></strike>')
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

  it('cancels, naming the cut, when the account came back without its end', async () => {
    const { hook, failures, settled } = hookWith('<trajectory>Where we are, cut mid-wo')
    expect(await hook(aged)).toEqual({ cancel: true })
    expect(failures).toEqual(['The trajectory summary came back empty or cut short.'])
    expect(settled).toEqual([])
  })

  // A skeleton stored by a build before the `notice` kind holds every run
  // report as the person's own words. Carried as stored, they were never
  // trimmed and never struck; one session's skeleton was 90 such lines and
  // 31k tokens, with every reply and call trimmed away around them.
  it('re-reads a carried skeleton with this build’s kinds, so old run reports can be trimmed', async () => {
    const report = `${RUN_MESSAGE_PREFIX} 4cc6 (build) completed · branch crucible/run-4cc6\n\n${'x'.repeat(7_000)}`
    const stale: StoredCompaction = {
      record: { trigger: 'threshold', tokensBefore: 1, tokensAfter: 1 },
      state: {
        skeleton: [
          { kind: 'user', text: report },
          { kind: 'user', text: 'proceed' },
          { kind: 'user', text: report.replace('4cc6', 'bc12') }
        ]
      }
    }
    const { hook, settled } = hookWith(
      '<trajectory>Standing here.</trajectory><strike></strike>',
      stale
    )
    const result = await hook(aged)
    expect(result?.cancel).toBeUndefined()
    expect(settled[0]?.state.skeleton.map((line) => line.kind)).toEqual([
      'notice',
      'user',
      'notice',
      'user',
      'user'
    ])
    // The text the model reads says who spoke, and what the line cost.
    expect(result?.compaction?.summary).toMatch(
      /\[crucible\] ⚑ Crucible run 4cc6 \(build\) completed · branch crucible\/run-4cc6 · 1,7\d\d tok dropped/
    )
    expect(result?.compaction?.summary).not.toContain('x'.repeat(100))
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
