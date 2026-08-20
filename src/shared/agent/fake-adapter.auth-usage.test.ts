// @vitest-environment node
//
// The free flavor has to be drivable end to end: a login that asks and answers,
// a logout, and usage numbers that are the same every run. No network, no cost.
import { describe, expect, it } from 'vitest'
import type { AdapterEvent } from './adapter'
import { createFakeAdapter, scaleUsage } from './fake-adapter'

const WORKSPACE = '/repos/crucible'

/** The adapter, its events, and a session already bound to a conversation. */
async function ready(): Promise<{
  adapter: ReturnType<typeof createFakeAdapter>
  events: AdapterEvent[]
}> {
  const adapter = createFakeAdapter({ pauseMs: 0 })
  const events: AdapterEvent[] = []
  adapter.onEvent((event) => events.push(event))
  return { adapter, events }
}

function promptId(events: readonly AdapterEvent[]): string {
  const asked = events.find((event) => event.type === 'auth_prompt')
  if (asked?.type !== 'auth_prompt') throw new Error('no question was asked')
  return asked.promptId
}

describe('the canned provider catalog', () => {
  it('has one provider of every status kind, and one that offers both methods', async () => {
    const { adapter } = await ready()

    const providers = await adapter.listProviders()

    expect(providers.map((provider) => provider.status.kind)).toEqual([
      'oauth',
      'api-key',
      'env',
      'none',
      'none'
    ])
    expect(providers.find((provider) => provider.status.kind === 'env')?.status).toEqual({
      kind: 'env',
      variable: 'GEMINI_API_KEY'
    })
    expect(providers.find((provider) => provider.id === 'openrouter')?.methods).toEqual([
      'oauth',
      'api-key'
    ])
  })
})

describe('the scripted login', () => {
  it('asks for a key, takes any non-empty answer, and joins the list', async () => {
    const { adapter, events } = await ready()

    const finished = adapter.login('groq', 'api-key')
    expect(events.at(-1)).toMatchObject({ type: 'auth_prompt', kind: 'secret' })

    await adapter.answerAuthPrompt(promptId(events), 'sk-anything')
    await expect(finished).resolves.toBeUndefined()

    const groq = (await adapter.listProviders()).find((provider) => provider.id === 'groq')
    expect(groq?.status).toEqual({ kind: 'api-key' })
  })

  it('opens a browser it never opens, and takes the pasted code', async () => {
    const { adapter, events } = await ready()

    const finished = adapter.login('openrouter', 'oauth')

    expect(events[0]).toMatchObject({
      type: 'auth_notice',
      notice: { kind: 'auth-url', message: 'Your browser opened for authorization.' }
    })
    expect(events[1]).toMatchObject({ type: 'auth_prompt', kind: 'manual-code' })

    await adapter.answerAuthPrompt(promptId(events), 'https://example.invalid/callback?code=x')
    await expect(finished).resolves.toBeUndefined()
    expect(
      (await adapter.listProviders()).find((provider) => provider.id === 'openrouter')?.status
    ).toMatchObject({ kind: 'oauth' })
  })

  it('refuses an empty answer display-safely and changes nothing', async () => {
    const { adapter, events } = await ready()

    const finished = adapter.login('groq', 'api-key')
    await adapter.answerAuthPrompt(promptId(events), '   ')

    await expect(finished).rejects.toThrow('That did not look like a key.')
    expect(
      (await adapter.listProviders()).find((provider) => provider.id === 'groq')?.status
    ).toEqual({ kind: 'none' })
  })

  it('closes the question and rejects when the login is cancelled', async () => {
    const { adapter, events } = await ready()

    const finished = adapter.login('groq', 'api-key')
    await adapter.cancelLogin()

    await expect(finished).rejects.toThrow('That login was cancelled.')
    expect(events.at(-1)).toMatchObject({ type: 'auth_prompt_closed' })
  })

  it('runs one login at a time', async () => {
    const { adapter, events } = await ready()

    const first = adapter.login('groq', 'api-key')
    await expect(adapter.login('openrouter', 'oauth')).rejects.toThrow(
      'A login is already under way.'
    )

    await adapter.answerAuthPrompt(promptId(events), 'sk-anything')
    await expect(first).resolves.toBeUndefined()
  })

  it('takes a credential away again on logout', async () => {
    const { adapter } = await ready()

    await adapter.logout('anthropic')

    expect(
      (await adapter.listProviders()).find((provider) => provider.id === 'anthropic')?.status
    ).toEqual({ kind: 'none' })
  })
})

describe('the canned usage numbers', () => {
  it('are nothing at all until a turn has run', async () => {
    const { adapter } = await ready()
    const bound = await adapter.bind({ sessionId: 's1', workspacePath: WORKSPACE })

    await expect(
      adapter.sessionUsage({ sessionId: 's1', workspacePath: WORKSPACE, token: bound.token })
    ).resolves.toBeUndefined()
  })

  it('sum one usage-bearing message per turn, and reach the snapshot as cost', async () => {
    const { adapter, events } = await ready()
    await adapter.bind({ sessionId: 's1', workspacePath: WORKSPACE })

    await adapter.prompt('s1', 't1', 'hello')

    expect(events.at(-1)).toMatchObject({ type: 'usage', sessionId: 's1', cost: 0.84 })
    await expect(
      adapter.sessionUsage({ sessionId: 's1', workspacePath: WORKSPACE })
    ).resolves.toEqual(scaleUsage(1))

    await adapter.prompt('s1', 't2', 'again')

    expect(events.at(-1)).toMatchObject({ type: 'usage', cost: 1.68 })
    await expect(
      adapter.sessionUsage({ sessionId: 's1', workspacePath: WORKSPACE })
    ).resolves.toEqual(scaleUsage(2))
  })

  it('answer for a session nobody bound, from its own token', async () => {
    const { adapter } = await ready()
    const bound = await adapter.bind({ sessionId: 's1', workspacePath: WORKSPACE })
    await adapter.prompt('s1', 't1', 'hello')
    adapter.release('s1')

    await expect(
      adapter.sessionUsage({ sessionId: 's1', workspacePath: WORKSPACE, token: bound.token })
    ).resolves.toEqual(scaleUsage(1))
  })

  it('keep what a jumped-away branch spent, because the money was spent', async () => {
    const { adapter } = await ready()
    await adapter.bind({ sessionId: 's1', workspacePath: WORKSPACE })
    await adapter.prompt('s1', 't1', 'first')
    await adapter.prompt('s1', 't2', 'second')
    const tree = await adapter.sessionTree('s1')
    const second = tree.roots[0]?.children[0]?.ref ?? ''

    await adapter.jump('s1', second, false)

    await expect(
      adapter.sessionUsage({ sessionId: 's1', workspacePath: WORKSPACE })
    ).resolves.toEqual(scaleUsage(2))
  })
})
