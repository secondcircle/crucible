// @vitest-environment node
//
// π's compaction entry is where a compaction survives a relaunch, and its
// `details` slot is a file this build will read back years from now. Read
// defensively: an entry π wrote itself, or one an older Crucible wrote, must
// leave the transcript standing rather than throwing on open.
import { describe, expect, it } from 'vitest'
import type { AgentSession, SessionEntry } from '@earendil-works/pi-coding-agent'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import {
  COMPACTION_DETAILS_KEY,
  askOnWarmCache,
  cutAtUserBoundary,
  previousCompaction,
  storedCompactionOf,
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
        [COMPACTION_DETAILS_KEY]: { record: { trigger: 'whatever' }, state: { skeleton: [] } }
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
      getAllTools: () =>
        tools.all.map((name) => ({ name, description: name, parameters: {} }))
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
        seen = { options, context: context as unknown as { tools?: { name: string }[] } }
        return {
          stopReason: 'stop',
          content: [{ type: 'text', text: '<trajectory>x</trajectory>' }]
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

  // Text up to where the provider stopped reads as an account and would
  // settle as one, with no strike list and an ending cut mid-sentence.
  it('refuses a reply the provider cut off', async () => {
    const ask = askOnWarmCache({
      session: sessionAt('high'),
      toLlm: (messages) => [...(messages as unknown as unknown[])],
      complete: async () =>
        ({
          stopReason: 'length',
          content: [{ type: 'text', text: '<trajectory>half an acc' }]
        }) as AssistantMessage
    })
    await expect(ask('compact this', new AbortController().signal)).rejects.toThrow(
      'did not finish (length)'
    )
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

describe('where the recent span starts', () => {
  const older = { role: 'user', content: 'older' } as StoredMessage
  const user = { role: 'user', content: 'the turn’s first message' } as StoredMessage
  const call = { role: 'assistant', content: [] } as unknown as StoredMessage
  const entries = [
    { id: 'e1', message: older },
    { id: 'e2', message: user },
    { id: 'e3', message: call }
  ] as unknown as SessionEntry[]

  it('takes π’s cut where π cut at a turn boundary', () => {
    expect(
      cutAtUserBoundary(
        {
          isSplitTurn: false,
          firstKeptEntryId: 'e2',
          messagesToSummarize: [older],
          turnPrefixMessages: []
        },
        entries
      )
    ).toEqual({ keptFrom: 'e2', aged: [older] })
  })

  // A turn bigger than the recent span would otherwise be half verbatim and
  // half skeleton, which is the one shape the window must never take.
  it('moves a cut that landed inside a turn back to that turn’s first message', () => {
    expect(
      cutAtUserBoundary(
        {
          isSplitTurn: true,
          firstKeptEntryId: 'e3',
          messagesToSummarize: [older],
          turnPrefixMessages: [user]
        },
        entries
      )
    ).toEqual({ keptFrom: 'e2', aged: [older] })
  })

  // Losing a stretch of the conversation from the window would be worse than
  // a split turn, so the prefix ages out with everything before it instead.
  it('ages the whole prefix out where the turn’s first message cannot be placed', () => {
    const adrift = { role: 'user', content: 'not in this branch' } as StoredMessage
    expect(
      cutAtUserBoundary(
        {
          isSplitTurn: true,
          firstKeptEntryId: 'e3',
          messagesToSummarize: [older],
          turnPrefixMessages: [adrift]
        },
        entries
      )
    ).toEqual({ keptFrom: 'e3', aged: [older, adrift] })
  })
})
