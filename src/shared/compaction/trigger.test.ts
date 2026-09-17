import { describe, expect, it } from 'vitest'
import { LONG_CACHE_TTL_MS } from '../cache/ttl'
import type { CompactionSettings } from './settings'
import {
  idleCompactionDelayMs,
  idleTrigger,
  sizeTrigger,
  SMALLEST_WORTH_COMPACTING
} from './trigger'

const ON: CompactionSettings = { enabled: true, thresholdK: 200 }
const OFF: CompactionSettings = { enabled: false, thresholdK: 200 }

describe('what a conversation’s size calls for', () => {
  it('compacts at the threshold with the switch on', () => {
    expect(sizeTrigger(ON, { usedTokens: 199_000, contextWindow: 1_000_000 })).toBeUndefined()
    expect(sizeTrigger(ON, { usedTokens: 200_000, contextWindow: 1_000_000 })).toBe('threshold')
  })

  it('compacts at the model’s window with the switch off', () => {
    expect(sizeTrigger(OFF, { usedTokens: 500_000, contextWindow: 1_000_000 })).toBeUndefined()
    expect(sizeTrigger(OFF, { usedTokens: 990_000, contextWindow: 1_000_000 })).toBe('windowEdge')
  })

  // The last resort outranks the setting: the alternative at the edge is a
  // conversation that errors on every send.
  it('compacts at the window when the threshold was set above it', () => {
    const wide: CompactionSettings = { enabled: true, thresholdK: 900 }
    expect(sizeTrigger(wide, { usedTokens: 190_000, contextWindow: 200_000 })).toBe('windowEdge')
  })

  it('leaves a conversation too small to gain anything alone', () => {
    expect(sizeTrigger(ON, { usedTokens: SMALLEST_WORTH_COMPACTING - 1 })).toBeUndefined()
    const tiny: CompactionSettings = { enabled: true, thresholdK: 20 }
    expect(sizeTrigger(tiny, { usedTokens: 25_000, contextWindow: 200_000 })).toBeUndefined()
  })

  it('says nothing about a window nobody reported', () => {
    expect(sizeTrigger(ON, { usedTokens: 210_000 })).toBe('threshold')
    expect(sizeTrigger(OFF, { usedTokens: 210_000 })).toBeUndefined()
  })
})

describe('the idle rule', () => {
  it('fires ten minutes before the hour lapses, and not at all under five minutes', () => {
    expect(idleCompactionDelayMs('1h')).toBe(50 * 60 * 1000)
    expect(idleCompactionDelayMs('5m')).toBeUndefined()
  })

  it('waits for the delay, then acts while the cache is still warm', () => {
    const facts = { lastRequestAt: 0, usedTokens: 300_000, retention: '1h' as const }
    expect(idleTrigger(facts, 49 * 60 * 1000)).toBeUndefined()
    expect(idleTrigger(facts, 50 * 60 * 1000)).toBe('idle')
    expect(idleTrigger(facts, 59 * 60 * 1000)).toBe('idle')
  })

  // Past the retention the prefix is gone, so the summarizing request would
  // re-bill the conversation it was meant to save.
  it('does nothing once the prefix has already lapsed', () => {
    const facts = { lastRequestAt: 0, usedTokens: 300_000, retention: '1h' as const }
    expect(idleTrigger(facts, LONG_CACHE_TTL_MS)).toBeUndefined()
  })

  it('leaves a conversation with nothing worth compacting alone however long it sits', () => {
    expect(
      idleTrigger({ lastRequestAt: 0, usedTokens: 5_000, retention: '1h' }, 55 * 60 * 1000)
    ).toBeUndefined()
  })

  // The switch governs the threshold, not the cache: the idle rule runs on
  // exactly the conversations a threshold would never reach.
  it('is not the setting’s to turn off', () => {
    expect(
      idleTrigger({ lastRequestAt: 0, usedTokens: 300_000, retention: '1h' }, 51 * 60 * 1000)
    ).toBe('idle')
  })
})
