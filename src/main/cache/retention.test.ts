// @vitest-environment node
//
// The decision on its own, against an environment the test hands it: no
// adapter, no ledger, no launch. Both SDK readers take their retention from
// this module and nothing else, so proving it here proves they agree.
import { describe, expect, it } from 'vitest'
import { CACHE_TTL_MS, cacheTtlMs } from '../../shared/cache/ttl'
import { retentionInForce } from './retention'

const MINUTE = 60 * 1000

describe('the retention in force', () => {
  it('asks for the hour, and writes it where π will read it', () => {
    const env: NodeJS.ProcessEnv = {}

    expect(retentionInForce(env)).toEqual({ retention: '1h', source: 'crucible' })
    // π reads the variable per request, so the whole of applying the default
    // is this one write: every agent this launch starts inherits it.
    expect(env.PI_CACHE_RETENTION).toBe('long')
  })

  it('leaves a variable the launch already carried exactly as it is', () => {
    const long: NodeJS.ProcessEnv = { PI_CACHE_RETENTION: 'long' }
    expect(retentionInForce(long)).toEqual({ retention: '1h', source: 'env' })
    expect(long.PI_CACHE_RETENTION).toBe('long')

    // Anything else means π's five-minute default, and it is the user's to
    // choose: there is no Settings toggle, and this is the override.
    const off: NodeJS.ProcessEnv = { PI_CACHE_RETENTION: 'off' }
    expect(retentionInForce(off)).toEqual({ retention: '5m', source: 'env' })
    expect(off.PI_CACHE_RETENTION).toBe('off')

    const empty: NodeJS.ProcessEnv = { PI_CACHE_RETENTION: '' }
    expect(retentionInForce(empty)).toEqual({ retention: '5m', source: 'env' })
  })

  it('answers the same however often it is asked', () => {
    const env: NodeJS.ProcessEnv = {}
    const first = retentionInForce(env)

    // Without the memory the second call would read the variable Crucible
    // itself wrote and call it the user's: the decision is the environment as
    // it was before the default was applied.
    expect(retentionInForce(env)).toEqual(first)
    expect(retentionInForce(env)).toEqual({ retention: '1h', source: 'crucible' })
  })

  it('touches no environment but the one it was given', () => {
    const before = process.env.PI_CACHE_RETENTION
    retentionInForce({ PI_CACHE_RETENTION: 'long' })
    retentionInForce({})

    expect(process.env.PI_CACHE_RETENTION).toBe(before)
  })
})

describe('the lifetime each retention buys', () => {
  it('is the five minutes π defaults to, and the hour the variable asks for', () => {
    expect(cacheTtlMs('5m')).toBe(CACHE_TTL_MS)
    expect(cacheTtlMs('5m')).toBe(5 * MINUTE)
    expect(cacheTtlMs('1h')).toBe(60 * MINUTE)
  })
})
