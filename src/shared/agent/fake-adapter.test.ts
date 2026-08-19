// @vitest-environment node
//
// The fake adapter is what every zero-cost check in this repository runs
// against, so what is asserted here is exactly what those checks are entitled
// to rely on: the script's order, its terminal events, that cancellation lands
// where it stands, that two sessions do not disturb each other, and that a
// conversation detached by reset is still findable. Nothing here waits on a
// clock — the adapter is built with no pause, so a turn is over in microtasks.
import { describe, expect, it } from 'vitest'
import type { AdapterEvent } from './adapter'
import { createFakeAdapter, FAKE_MODEL } from './fake-adapter'

const WORKSPACE = '/workspaces/crucible'

/** An adapter with one bound session, and everything it says, in order. */
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

describe('the scripted turn', () => {
  it('runs thinking, one tool call, a markdown reply, usage, then the end', async () => {
    const { adapter, events } = await withSession()

    await adapter.prompt('s1', 't-1', 'hello')

    expect(types(events)).toEqual([
      'turn_started',
      'thinking_delta',
      'thinking_delta',
      'thinking_delta',
      'tool_started',
      'tool_output',
      'tool_output',
      'tool_output',
      'tool_ended',
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

  it('keeps one tool call, opened and closed, with its output', async () => {
    const { adapter, events } = await withSession()

    await adapter.prompt('s1', 't-1', 'hello')
    const started = events.find((event) => event.type === 'tool_started')
    const ended = events.find((event) => event.type === 'tool_ended')

    expect(started).toMatchObject({ name: 'bash', summary: 'npm test' })
    expect(ended).toMatchObject({ ok: true, callId: started?.callId })
    expect(ended?.type === 'tool_ended' ? ended.output : '').toContain('42 passed')
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
      if (event.sessionId === 'a' && event.type === 'text_delta') void adapter.cancel('a')
    })

    await Promise.all([adapter.prompt('a', 't-a', 'one'), adapter.prompt('b', 't-b', 'two')])

    const forA = events.filter((event) => event.sessionId === 'a')
    const forB = events.filter((event) => event.sessionId === 'b')
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

    // A second adapter is a second launch: its history holds the canned
    // entries and nothing else, so the old token binds a fresh conversation
    // and says so rather than landing on some other conversation.
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
