// @vitest-environment node
//
// The classification the settings surface reads, proven without constructing
// an SDK adapter and therefore without a paid call.
import { describe, expect, it } from 'vitest'
import { methodsOf, toProviderState, type ProviderFacts } from './providers'

const ANTHROPIC: ProviderFacts = {
  id: 'anthropic',
  name: 'Anthropic',
  oauth: { name: 'Anthropic (Claude Pro/Max)', isSubscription: true },
  apiKey: { interactive: true }
}

const BEDROCK: ProviderFacts = {
  id: 'bedrock',
  name: 'Amazon Bedrock',
  // Ambient credentials only: π offers no `login`, so Crucible offers none.
  apiKey: { interactive: false }
}

describe('what a login could use', () => {
  it('names OAuth first, then an api key, and nothing for ambient-only', () => {
    expect(methodsOf(ANTHROPIC)).toEqual(['oauth', 'api-key'])
    expect(methodsOf({ id: 'openai', name: 'OpenAI', apiKey: { interactive: true } })).toEqual([
      'api-key'
    ])
    expect(methodsOf(BEDROCK)).toEqual([])
  })
})

describe('what the credentials say', () => {
  it('is none when π reports no credential at all', () => {
    expect(toProviderState(ANTHROPIC).status).toEqual({ kind: 'none' })
  })

  it('carries π\u2019s own word for an OAuth credential as the detail', () => {
    expect(
      toProviderState(ANTHROPIC, { type: 'oauth', source: 'Claude subscription' }).status
    ).toEqual({ kind: 'oauth', detail: 'Claude subscription' })
  })

  it('falls back to the provider\u2019s own OAuth name when the source says only "OAuth"', () => {
    expect(toProviderState(ANTHROPIC, { type: 'oauth', source: 'OAuth' }).status).toEqual({
      kind: 'oauth',
      detail: 'Anthropic (Claude Pro/Max)'
    })
    expect(
      toProviderState({ id: 'x', name: 'X', oauth: {} }, { type: 'oauth' }).status
    ).toEqual({ kind: 'oauth' })
  })

  it('tells a stored key from one that came out of the environment', () => {
    expect(
      toProviderState(ANTHROPIC, { type: 'api_key', source: 'ANTHROPIC_API_KEY' }).status
    ).toEqual({ kind: 'env', variable: 'ANTHROPIC_API_KEY' })
    expect(toProviderState(ANTHROPIC, { type: 'api_key' }).status).toEqual({ kind: 'api-key' })
    expect(
      toProviderState(BEDROCK, { type: 'api_key', source: '~/.aws/credentials' }).status
    ).toEqual({ kind: 'api-key' })
  })

  it('reports a whole provider, name and all', () => {
    expect(toProviderState(ANTHROPIC, { type: 'api_key' })).toEqual({
      id: 'anthropic',
      name: 'Anthropic',
      methods: ['oauth', 'api-key'],
      status: { kind: 'api-key' }
    })
  })
})
