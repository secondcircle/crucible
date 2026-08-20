// @vitest-environment node
//
// Every zero-cost check runs against this adapter, so what those checks rely
// on is pinned here.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdapterEvent } from './adapter'
import { createFakeAdapter, FAKE_MODEL } from './fake-adapter'

const WORKSPACE = '/workspaces/crucible'

async function withSession(sessionId = 's1'): Promise<{
  adapter: ReturnType<typeof createFakeAdapter>
  events: AdapterEvent[]
}> {
  const adapter = createFakeAdapter({ pauseMs: 0 })
  await adapter.bind({ sessionId, workspacePath: WORKSPACE })
  const events: AdapterEvent[] = []
  adapter.onEvent((event) => events.push(event))
  return { adapter, events }
}

const types = (events: readonly AdapterEvent[]): string[] => events.map((event) => event.type)

// One test below drives the paced script under fake timers; every other builds
// the adapter with no pause and waits on no clock.
afterEach(() => {
  vi.useRealTimers()
})

/** One call: its start, a chunk of output for each chunk it streams, its end. */
const call = (chunks: number): string[] => [
  'tool_started',
  ...Array.from({ length: chunks }, () => 'tool_output'),
  'tool_ended'
]

describe('the scripted turn', () => {
  it('runs thinking, a chain of calls, a lone call, a reply, usage, then the end', async () => {
    const { adapter, events } = await withSession()

    await adapter.prompt('s1', 't-1', 'hello')

    expect(types(events)).toEqual([
      'turn_started',
      'thinking_delta',
      'thinking_delta',
      'thinking_delta',
      // Three consecutive calls, which is one tool chain.
      ...call(3),
      ...call(1),
      ...call(1),
      // Text ends that chain, so what follows is a chain of one.
      'text_delta',
      ...call(1),
      ...Array.from({ length: 13 }, () => 'text_delta'),
      'turn_ended',
      'usage'
    ])
  })

  it('replies in markdown with a list, inline code and a fenced block', async () => {
    const { adapter, events } = await withSession()

    await adapter.prompt('s1', 't-1', 'hello')
    const reply = events
      .filter((event) => event.type === 'text_delta')
      .map((event) => event.delta)
      .join('')

    expect(reply).toContain('\n- ')
    expect(reply).toContain('`inline code`')
    expect(reply).toContain('```ts')
  })

  it('opens and closes every call it starts, with its output', async () => {
    const { adapter, events } = await withSession()

    await adapter.prompt('s1', 't-1', 'hello')
    const started = events.filter((event) => event.type === 'tool_started')
    const ended = events.filter((event) => event.type === 'tool_ended')

    expect(started[0]).toMatchObject({ name: 'bash', summary: 'npm test' })
    expect(ended.map((event) => event.callId)).toEqual(started.map((event) => event.callId))
    expect(ended[0].type === 'tool_ended' ? ended[0].output : '').toContain('42 passed')
  })

  it('spans two tool names in one chain and fails exactly one of the calls', async () => {
    const { adapter, events } = await withSession()

    await adapter.prompt('s1', 't-1', 'hello')
    const started = events.filter((event) => event.type === 'tool_started')
    const ended = events.filter((event) => event.type === 'tool_ended')

    // Three in the chain and one on its own, under two names, so a single
    // scripted turn shows the counts, the failure marker and a chain of one.
    expect(started).toHaveLength(4)
    expect(new Set(started.map((event) => event.name))).toEqual(new Set(['bash', 'read']))
    expect(ended.filter((event) => !event.ok)).toHaveLength(1)
  })

  it('reports usage that is inside the window and grows with the conversation', async () => {
    const { adapter, events } = await withSession()

    await adapter.prompt('s1', 't-1', 'hello')
    await adapter.prompt('s1', 't-2', 'again')
    const usage = events.filter((event) => event.type === 'usage')

    expect(usage).toHaveLength(2)
    expect(usage[0].usedTokens).toBeGreaterThan(0)
    expect(usage[1].usedTokens).toBeGreaterThan(usage[0].usedTokens)
    expect(usage[1].usedTokens).toBeLessThan(usage[1].contextWindow)
  })
})

// π's own queueing semantics, implemented here so both features are
// exercisable without a paid call.
describe('queued messages', () => {
  /** Queues through `at`, once, the first time that event type arrives. */
  function once(
    adapter: ReturnType<typeof createFakeAdapter>,
    type: AdapterEvent['type'],
    act: () => void
  ): void {
    let done = false
    adapter.onEvent((event) => {
      if (event.type !== type || done) return
      done = true
      act()
    })
  }

  it('delivers every queued steering message at the next boundary between calls', async () => {
    const { adapter, events } = await withSession()
    once(adapter, 'tool_started', () => {
      void adapter.steer('s1', 'check the adapter too')
      void adapter.steer('s1', 'and the tests')
    })

    await adapter.prompt('s1', 't-1', 'hello')

    const at = types(events).indexOf('user_message')
    // The whole queue lands as a group, between the call that was running and
    // the next one.
    expect(types(events).slice(at - 1, at + 5)).toEqual([
      'tool_ended',
      'user_message',
      'queue_changed',
      'user_message',
      'queue_changed',
      'tool_started'
    ])
    expect(events.slice(at).filter((event) => event.type === 'user_message')).toMatchObject([
      { text: 'check the adapter too' },
      { text: 'and the tests' }
    ])
    expect(events[at + 1]).toMatchObject({ steering: ['and the tests'] })
    expect(events[at + 3]).toMatchObject({ steering: [], followUp: [] })
  })

  it('holds a follow-up until the reply is done, answers it, and only then ends', async () => {
    const { adapter, events } = await withSession()
    once(adapter, 'tool_started', () => {
      void adapter.followUp('s1', 'summarize what you would refactor first')
    })

    await adapter.prompt('s1', 't-1', 'hello')

    const at = types(events).indexOf('user_message')
    // Nothing of it before the reply was streamed in full.
    expect(types(events).slice(0, at).filter((type) => type === 'text_delta').length).toBe(14)
    expect(types(events).slice(at)).toEqual([
      'user_message',
      'queue_changed',
      'text_delta',
      'turn_ended',
      'usage'
    ])
  })

  it('hands both queues back before it says the turn was cancelled', async () => {
    const { adapter, events } = await withSession()
    once(adapter, 'tool_started', () => {
      void adapter.steer('s1', 'stop reading and write it')
      void adapter.followUp('s1', 'then summarize')
      void adapter.cancel('s1')
    })

    await adapter.prompt('s1', 't-1', 'hello')

    const flushed = events.find((event) => event.type === 'queue_flushed')
    expect(flushed).toMatchObject({
      messages: [
        { kind: 'steering', text: 'stop reading and write it' },
        { kind: 'followUp', text: 'then summarize' }
      ]
    })
    expect(types(events).indexOf('queue_flushed')).toBeLessThan(
      types(events).indexOf('turn_cancelled')
    )
    // Nothing the user got back is delivered after they killed the turn.
    expect(types(events)).not.toContain('user_message')
  })

  it('queues nothing into a session with no live run, and says so', async () => {
    const { adapter, events } = await withSession()

    expect(await adapter.steer('s1', 'hello')).toBe('idle')
    expect(await adapter.followUp('s1', 'hello')).toBe('idle')

    expect(events).toEqual([])
  })

  it('dequeues exactly the named entry, and answers false for a delivered one', async () => {
    const { adapter, events } = await withSession()
    const removed: boolean[] = []
    once(adapter, 'tool_started', () => {
      void adapter.steer('s1', 'one')
      void adapter.steer('s1', 'two')
      void adapter.dequeue('s1', 'steering', 'one').then((answer) => removed.push(answer))
    })

    await adapter.prompt('s1', 't-1', 'hello')

    expect(removed).toEqual([true])
    expect(events.filter((event) => event.type === 'user_message')).toMatchObject([{ text: 'two' }])
    // Already delivered: there is nothing left to take back.
    expect(await adapter.dequeue('s1', 'steering', 'two')).toBe(false)
  })

  it('settles a delivered message into the conversation where it was delivered', async () => {
    const { adapter } = await withSession()
    once(adapter, 'tool_started', () => {
      void adapter.steer('s1', 'check the tests too')
    })

    await adapter.prompt('s1', 't-1', 'hello')
    const transcript = await adapter.transcript('s1')

    const at = transcript.findIndex(
      (item) => item.kind === 'user' && item.text === 'check the tests too'
    )
    // A restored transcript reads as the live one did, between the call that
    // was running and the one that followed it.
    expect(transcript[at - 1].kind).toBe('tool')
    expect(transcript[at + 1].kind).toBe('tool')
  })

  // The script's final pause sits after its last queue check, which is the
  // window a message can be stranded in.
  it('delivers or flushes a message queued during the turn’s final pause', async () => {
    vi.useFakeTimers()
    const adapter = createFakeAdapter({ pauseMs: 10 })
    await adapter.bind({ sessionId: 's1', workspacePath: WORKSPACE })
    const events: AdapterEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const lastDelta = 'Stop or Escape ends this turn wherever it stands.'

    const turn = adapter.prompt('s1', 't-1', 'hello')
    // Advance beat by beat until the reply has fully streamed; the script now
    // stands in the pause between its last queue check and its end.
    for (let beats = 0; beats < 200; beats += 1) {
      if (events.some((event) => event.type === 'text_delta' && event.delta === lastDelta)) break
      await vi.advanceTimersByTimeAsync(10)
    }
    expect(await adapter.steer('s1', 'one more thing')).toBe('queued')

    await vi.advanceTimersByTimeAsync(1_000)
    await turn

    expect(types(events)).toContain('turn_ended')
    const delivered = events.some(
      (event) => event.type === 'user_message' && event.text === 'one more thing'
    )
    const flushed = events.some(
      (event) =>
        event.type === 'queue_flushed' &&
        event.messages.some((message) => message.text === 'one more thing')
    )
    expect(delivered || flushed).toBe(true)
  })

  it('discards a released session’s queue rather than restoring it to nowhere', async () => {
    const { adapter, events } = await withSession()
    once(adapter, 'tool_started', () => {
      void adapter.steer('s1', 'never delivered')
      adapter.release('s1')
    })

    await adapter.prompt('s1', 't-1', 'hello')

    expect(types(events)).not.toContain('queue_flushed')
    expect(types(events)).not.toContain('user_message')
  })
})

describe('cancellation', () => {
  it('ends the turn as cancelled where the script stood, and says no more', async () => {
    const { adapter, events } = await withSession()

    // Stop the moment the reply starts streaming: the partial text stands and
    // the turn ends as cancelled rather than as an error or a normal end.
    adapter.onEvent((event) => {
      if (event.type === 'text_delta') void adapter.cancel('s1')
    })
    await adapter.prompt('s1', 't-1', 'hello')

    expect(types(events)).toContain('text_delta')
    expect(types(events)).not.toContain('turn_ended')
    const terminal = events.findIndex((event) => event.type === 'turn_cancelled')
    expect(terminal).toBeGreaterThan(0)
    // Only usage follows a terminal event, and nothing of the turn does.
    expect(types(events).slice(terminal + 1)).toEqual(['usage'])
  })

  it('leaves the partial reply and a stopped marker in the conversation', async () => {
    const { adapter } = await withSession()

    adapter.onEvent((event) => {
      if (event.type === 'text_delta') void adapter.cancel('s1')
    })
    await adapter.prompt('s1', 't-1', 'hello')
    const transcript = await adapter.transcript('s1')

    expect(transcript.at(-1)).toEqual({ kind: 'stopped' })
    expect(transcript.some((item) => item.kind === 'assistant')).toBe(true)
  })

  it('does nothing at all when the session has no live turn', async () => {
    const { adapter, events } = await withSession()

    await adapter.cancel('s1')
    await adapter.cancel('nobody')

    expect(events).toEqual([])
  })

  it('accepts the next prompt as a redirect', async () => {
    const { adapter, events } = await withSession()

    const stopEarly = adapter.onEvent((event) => {
      if (event.type === 'text_delta') void adapter.cancel('s1')
    })
    await adapter.prompt('s1', 't-1', 'hello')
    stopEarly()
    await adapter.prompt('s1', 't-2', 'do this instead')

    expect(types(events)).toContain('turn_cancelled')
    expect(events.filter((event) => event.type === 'turn_ended')).toHaveLength(1)
  })
})

describe('concurrent sessions', () => {
  it('runs independent scripts, and cancelling one leaves the other alone', async () => {
    const adapter = createFakeAdapter({ pauseMs: 0 })
    await adapter.bind({ sessionId: 'a', workspacePath: WORKSPACE })
    await adapter.bind({ sessionId: 'b', workspacePath: WORKSPACE })
    const events: AdapterEvent[] = []
    adapter.onEvent((event) => events.push(event))
    adapter.onEvent((event) => {
      if (event.type === 'text_delta' && event.sessionId === 'a') void adapter.cancel('a')
    })

    await Promise.all([adapter.prompt('a', 't-a', 'one'), adapter.prompt('b', 't-b', 'two')])

    // Auth events carry no session at all, which is why membership is
    // checked before the id is read.
    const ofSession = (id: string): AdapterEvent[] =>
      events.filter((event) => 'sessionId' in event && event.sessionId === id)
    const forA = ofSession('a')
    const forB = ofSession('b')
    expect(types(forA)).toContain('turn_cancelled')
    expect(types(forA)).not.toContain('turn_ended')
    expect(types(forB)).toContain('turn_ended')
    expect(types(forB)).not.toContain('turn_cancelled')
  })
})

describe('history, reset and resume', () => {
  it('serves canned entries for a workspace nobody has worked in yet', async () => {
    const adapter = createFakeAdapter({ pauseMs: 0 })

    const found = await adapter.searchHistory(WORKSPACE, '')

    expect(found.length).toBeGreaterThanOrEqual(2)
    expect(found.every((match) => match.preview !== '')).toBe(true)
  })

  it('filters what it serves by the query', async () => {
    const adapter = createFakeAdapter({ pauseMs: 0 })

    const found = await adapter.searchHistory(WORKSPACE, 'ember palette')

    expect(found).toHaveLength(1)
    // The preview is the conversation's last words; the query reads all of it.
    expect(found[0].preview).toContain('token source')
  })

  it('detaches a conversation on reset and keeps it findable', async () => {
    const { adapter } = await withSession()
    await adapter.prompt('s1', 't-1', 'the sentence that identifies this conversation')
    const before = await adapter.bind({ sessionId: 's1', workspacePath: WORKSPACE })

    const after = await adapter.reset('s1')

    expect(after.token).not.toBe(before.token)
    expect(await adapter.transcript('s1')).toEqual([])
    const found = await adapter.searchHistory(WORKSPACE, 'identifies this conversation')
    expect(found).toHaveLength(1)
    expect(adapter.sameConversation(before.token, found[0].ref)).toBe(true)
  })

  it('restores a detached conversation, transcript and all, on resume', async () => {
    const { adapter } = await withSession()
    await adapter.prompt('s1', 't-1', 'a sentence to find again')
    await adapter.reset('s1')
    const [match] = await adapter.searchHistory(WORKSPACE, 'a sentence to find again')

    const resumed = await adapter.resume({
      sessionId: 's2',
      workspacePath: WORKSPACE,
      ref: match.ref
    })
    const transcript = await adapter.transcript('s2')

    expect(resumed.restored).toBe(true)
    expect(transcript[0]).toEqual({ kind: 'user', text: 'a sentence to find again' })
  })

  it('gives a conversation this launch created a token no later launch can hit', async () => {
    const { adapter } = await withSession()
    await adapter.prompt('s1', 't-1', 'said this launch')
    const live = await adapter.bind({ sessionId: 's1', workspacePath: WORKSPACE })

    // A second adapter is a second launch, so a token from the first has to
    // bind a fresh conversation rather than land on some other one.
    const relaunched = createFakeAdapter({ pauseMs: 0 })
    const rebound = await relaunched.bind({
      sessionId: 's1',
      workspacePath: WORKSPACE,
      token: live.token
    })

    expect(rebound.restored).toBe(false)
    expect(await relaunched.transcript('s1')).toEqual([])
  })

  it('keeps a removed session\u2019s conversation in history', async () => {
    const { adapter } = await withSession()
    await adapter.prompt('s1', 't-1', 'a removed conversation')

    adapter.release('s1')

    const found = await adapter.searchHistory(WORKSPACE, 'a removed conversation')
    expect(found).toHaveLength(1)
  })
})

describe('what it says about itself', () => {
  it('exposes one model that says it is fake, with more than one level', async () => {
    const adapter = createFakeAdapter({ pauseMs: 0 })

    const models = await adapter.listModels()

    expect(models).toEqual([FAKE_MODEL])
    expect(models[0].id).toBe('fake/deterministic')
    expect(models[0].label.toLowerCase()).toContain('fake')
    expect(models[0].thinkingLevels.length).toBeGreaterThanOrEqual(2)
  })

  it('refuses a model or a level it cannot honestly serve', async () => {
    const { adapter } = await withSession()

    await expect(adapter.setModel('s1', 'anthropic/claude-opus-4-5')).rejects.toThrow()
    await expect(adapter.setThinkingLevel('s1', 'xhigh')).rejects.toThrow()
    await expect(adapter.setThinkingLevel('s1', 'high')).resolves.toBeUndefined()
  })

  it('skips the thinking block when the level is off', async () => {
    const { adapter, events } = await withSession()
    await adapter.setThinkingLevel('s1', 'off')

    await adapter.prompt('s1', 't-1', 'hello')

    expect(types(events)).not.toContain('thinking_delta')
  })
})
