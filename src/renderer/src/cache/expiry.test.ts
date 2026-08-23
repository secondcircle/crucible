// @vitest-environment node
//
// The trigger's one question, on its own: whether the provider has certainly
// dropped this conversation's prefix.
import { describe, expect, it } from 'vitest'
import type { CachedPrefix } from '../../../shared/agent/port'
import { idleMs, prefixExpired } from './expiry'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const NOW = Date.parse('2026-08-20T15:04:00.000Z')

function prefix(agoMs: number, retention: CachedPrefix['retention'] = '1h'): CachedPrefix {
  return {
    at: new Date(NOW - agoMs).toISOString(),
    tokens: 110_000,
    rebillDollars: 0.63,
    retention
  }
}

describe('whether the prefix is gone', () => {
  it('reads the lifetime the retention it was written under buys', () => {
    expect(prefixExpired(prefix(20 * MINUTE, '1h'), NOW)).toBe(false)
    expect(prefixExpired(prefix(20 * MINUTE, '5m'), NOW)).toBe(true)
    expect(prefixExpired(prefix(2 * HOUR + 13 * MINUTE, '1h'), NOW)).toBe(true)
  })

  it('holds the cache alive right up to the line, and not past it', () => {
    expect(prefixExpired(prefix(HOUR, '1h'), NOW)).toBe(false)
    expect(prefixExpired(prefix(HOUR + 1, '1h'), NOW)).toBe(true)
    expect(prefixExpired(prefix(5 * MINUTE, '5m'), NOW)).toBe(false)
    expect(prefixExpired(prefix(5 * MINUTE + 1, '5m'), NOW)).toBe(true)
  })

  it('raises nothing on a stamp it cannot read', () => {
    // A dialog on a guess is worse than no dialog: the whole claim it makes
    // is that the re-bill is certain.
    expect(prefixExpired({ ...prefix(0), at: 'not a time' }, NOW)).toBe(false)
    expect(idleMs({ ...prefix(0), at: 'not a time' }, NOW)).toBe(0)
  })

  it('measures the idle time from the last billed request', () => {
    expect(idleMs(prefix(2 * HOUR + 13 * MINUTE), NOW)).toBe(2 * HOUR + 13 * MINUTE)
    // A clock that went backwards is nobody's evidence of an idle hour.
    expect(idleMs(prefix(-5 * MINUTE), NOW)).toBe(0)
  })
})
