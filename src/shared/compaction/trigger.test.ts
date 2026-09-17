import { describe, expect, it } from 'vitest'
import { LONG_CACHE_TTL_MS } from '../cache/ttl'
import { MIN_THRESHOLD_K, thresholdTokens, type CompactionSettings } from './settings'
import {
  idleCompactionDelayMs,
  idleTrigger,
  sizeTrigger
} from './trigger'
import { SMALLEST_WORTH_COMPACTING } from './window'

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

  // The floor is the smallest threshold the field accepts, so a conversation
  // under it is one nobody could have asked to compact.
  it('leaves a conversation too small to gain anything alone', () => {
    const lowest: CompactionSettings = { enabled: true, thresholdK: MIN_THRESHOLD_K }
    expect(thresholdTokens(lowest)).toBe(SMALLEST_WORTH_COMPACTING)
    expect(sizeTrigger(lowest, { usedTokens: SMALLEST_WORTH_COMPACTING - 1 })).toBeUndefined()
    expect(sizeTrigger(lowest, { usedTokens: SMALLEST_WORTH_COMPACTING })).toBe('threshold')
  })

  it('says nothing about a window nobody reported', () => {
    expect(sizeTrigger(ON, { usedTokens: 210_000 })).toBe('threshold')
    expect(sizeTrigger(OFF, { usedTokens: 210_000 })).toBeUndefined()
  })

  // π's catalog lists 8k, 16k and 32k models. The floor and the reserve are
  // sized for a 200k-plus window, so left absolute they would put the edge
  // out of reach on every one of them and the conversation would grow until
  // the provider refused it.
  it('still reaches the edge on a model smaller than the floor', () => {
    expect(sizeTrigger(ON, { usedTokens: 30_000, contextWindow: 32_768 })).toBe('windowEdge')
    expect(sizeTrigger(OFF, { usedTokens: 30_000, contextWindow: 32_768 })).toBe('windowEdge')
    expect(sizeTrigger(ON, { usedTokens: 7_000, contextWindow: 8_192 })).toBe('windowEdge')
  })

  // Below the edge the floor still holds, measured against the window it has:
  // a quarter of a 32k model is the recent span a compaction would keep, and
  // twice that is the least worth rewriting.
  it('leaves a small model’s short conversation alone', () => {
    expect(sizeTrigger(ON, { usedTokens: 12_000, contextWindow: 32_768 })).toBeUndefined()
  })
})

describe('the idle rule', () => {
  it('fires ten minutes before the hour lapses, and not at all under five minutes', () => {
    expect(idleCompactionDelayMs('1h')).toBe(50 * 60 * 1000)
    expect(idleCompactionDelayMs('5m')).toBeUndefined()
  })

  it('waits for the delay, then acts while the cache is still warm', () => {
    const facts = { lastRequestAt: 0, usedTokens: 300_000, retention: '1h' as const }
    expect(idleTrigger(ON, facts, 49 * 60 * 1000)).toBeUndefined()
    expect(idleTrigger(ON, facts, 50 * 60 * 1000)).toBe('idle')
    expect(idleTrigger(ON, facts, 59 * 60 * 1000)).toBe('idle')
  })

  // Past the retention the prefix is gone, so the summarizing request would
  // re-bill the conversation it was meant to save.
  it('does nothing once the prefix has already lapsed', () => {
    const facts = { lastRequestAt: 0, usedTokens: 300_000, retention: '1h' as const }
    expect(idleTrigger(ON, facts, LONG_CACHE_TTL_MS)).toBeUndefined()
  })

  it('leaves a conversation with nothing worth compacting alone however long it sits', () => {
    expect(
      idleTrigger(ON, { lastRequestAt: 0, usedTokens: 5_000, retention: '1h' }, 55 * 60 * 1000)
    ).toBeUndefined()
  })

  // An idle compaction is a paid background request that rewrites what the
  // agent reads, so the feature's switch governs it like everything else. The
  // one thing that survives the switch being off is the window edge, which is
  // the alternative to a conversation that errors on every send.
  it('is the setting’s to turn off', () => {
    expect(
      idleTrigger(OFF, { lastRequestAt: 0, usedTokens: 300_000, retention: '1h' }, 51 * 60 * 1000)
    ).toBeUndefined()
    expect(
      idleTrigger(ON, { lastRequestAt: 0, usedTokens: 300_000, retention: '1h' }, 51 * 60 * 1000)
    ).toBe('idle')
  })

  // The floor is the recent span doubled, and on a small model the recent
  // span is a share of the window rather than 20k of it.
  it('measures “worth compacting” against the model’s own window', () => {
    const facts = { lastRequestAt: 0, usedTokens: 20_000, retention: '1h' as const }
    expect(idleTrigger(ON, facts, 51 * 60 * 1000)).toBeUndefined()
    expect(idleTrigger(ON, { ...facts, contextWindow: 32_768 }, 51 * 60 * 1000)).toBe('idle')
  })
})
