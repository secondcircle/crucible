// @vitest-environment node
//
// π's cache-miss arithmetic, mirrored and proven with plain data: no SDK
// session, no adapter, no conversation — just the numbers a message carries.
import { describe, expect, it } from 'vitest'
import {
  billsPrompt,
  createCacheMissTracker,
  NOISE_FLOOR_TOKENS,
  scanCacheMisses,
  type CacheMessage,
  type CacheScanEntry
} from './cache-miss'

const MINUTE = 60 * 1000

/** One assistant message, in π's own per-message shape. */
function message(
  over: {
    input?: number
    cacheRead?: number
    cacheWrite?: number
    costInput?: number
    costCacheRead?: number
    costCacheWrite?: number
    provider?: string
    model?: string
    at?: number
  } = {}
): CacheMessage {
  const input = over.input ?? 0
  const cacheRead = over.cacheRead ?? 0
  const cacheWrite = over.cacheWrite ?? 0
  return {
    provider: over.provider ?? 'anthropic',
    model: over.model ?? 'claude-opus-5',
    timestamp: over.at ?? 0,
    usage: {
      input,
      output: 500,
      cacheRead,
      cacheWrite,
      cost: {
        input: over.costInput ?? 0,
        cacheRead: over.costCacheRead ?? 0,
        cacheWrite: over.costCacheWrite ?? 0
      }
    }
  }
}

const assistant = (message: CacheMessage): CacheScanEntry => ({ kind: 'assistant', message })

describe('what counts as a cache miss', () => {
  it('counts nothing on the first turn: there is nothing to compare against', () => {
    const tracker = createCacheMissTracker()

    expect(tracker.observe(message({ input: 50_000, cacheWrite: 50_000 }))).toBeUndefined()
  })

  it('counts a zero-cache turn only once cache activity has been reported', () => {
    // A provider that never caches is not missing, however large its prompts.
    const never = createCacheMissTracker()
    never.observe(message({ input: 80_000 }))
    expect(never.observe(message({ input: 80_000 }))).toBeUndefined()

    // One that cached before and reads nothing now missed the whole prompt.
    const cached = createCacheMissTracker()
    cached.observe(message({ input: 10_000, cacheWrite: 70_000 }))
    const miss = cached.observe(message({ input: 80_000 }))
    expect(miss?.missedTokens).toBe(80_000)
  })

  it('re-bills the smaller of the two prompts, less what was read from cache', () => {
    const tracker = createCacheMissTracker()
    tracker.observe(message({ input: 10_000, cacheWrite: 90_000 }))
    // The prompt grew, so the previous turn's 100k is the ceiling; 40k of it
    // was read back, and the rest was paid for twice.
    const miss = tracker.observe(message({ input: 80_000, cacheRead: 40_000 }))

    expect(miss?.missedTokens).toBe(60_000)
  })

  it('treats a miss at or below π\u2019s noise floor as breakpoint granularity', () => {
    const tracker = createCacheMissTracker()
    tracker.observe(message({ input: 1_000, cacheWrite: 99_000 }))
    // The same 100k prompt again, all but 1024 tokens of it read back.
    const floor = tracker.observe(
      message({ input: NOISE_FLOOR_TOKENS, cacheRead: 100_000 - NOISE_FLOOR_TOKENS })
    )
    expect(floor).toBeUndefined()

    const over = createCacheMissTracker()
    over.observe(message({ input: 1_000, cacheWrite: 99_000 }))
    const miss = over.observe(
      message({ input: NOISE_FLOOR_TOKENS + 1, cacheRead: 100_000 - NOISE_FLOOR_TOKENS - 1 })
    )
    expect(miss?.missedTokens).toBe(NOISE_FLOOR_TOKENS + 1)
  })

  it('prices the missed tokens at what was really paid, write premium and all', () => {
    const tracker = createCacheMissTracker()
    tracker.observe(message({ input: 10_000, cacheWrite: 90_000 }))
    // 20k input at $15/M and 80k cache writes at $18.75/M: $18/M paid,
    // against $1.50/M the cache read cost. 100k missed at $16.50/M.
    const miss = tracker.observe(
      message({
        input: 20_000,
        cacheWrite: 80_000,
        cacheRead: 10_000,
        costInput: 0.3,
        costCacheWrite: 1.5,
        costCacheRead: 0.015
      })
    )

    expect(miss?.missedTokens).toBe(90_000)
    expect(miss?.missedCost).toBeCloseTo(90_000 * (18 - 1.5) * 1e-6, 6)
  })

  it('falls back to the model\u2019s listed cache-read rate, then to nothing', () => {
    const priced = createCacheMissTracker({
      listedCacheReadPerMillion: () => 1.5
    })
    priced.observe(message({ input: 10_000, cacheWrite: 90_000 }))
    // No cache read of its own, so the listed rate is what the miss is
    // measured against: $15/M paid, $1.50/M listed.
    const withRate = priced.observe(message({ input: 100_000, costInput: 1.5 }))
    expect(withRate?.missedCost).toBeCloseTo(100_000 * 13.5 * 1e-6, 6)

    const unpriced = createCacheMissTracker()
    unpriced.observe(message({ input: 10_000, cacheWrite: 90_000 }))
    const noRate = unpriced.observe(message({ input: 100_000, costInput: 1.5 }))
    expect(noRate?.missedCost).toBeCloseTo(100_000 * 15 * 1e-6, 6)
  })

  it('never bills a negative difference', () => {
    const tracker = createCacheMissTracker({ listedCacheReadPerMillion: () => 100 })
    tracker.observe(message({ input: 10_000, cacheWrite: 90_000 }))
    // A listed read rate above what was paid would owe the user money, which
    // is not a thing a ledger of waste may say.
    const miss = tracker.observe(message({ input: 100_000, costInput: 0.1 }))

    expect(miss?.missedTokens).toBe(100_000)
    expect(miss?.missedCost).toBe(0)
  })

  it('measures the gap from the previous request, and never backwards', () => {
    const tracker = createCacheMissTracker()
    tracker.observe(message({ input: 10_000, cacheWrite: 90_000, at: 8 * 60 * MINUTE }))
    const miss = tracker.observe(
      message({ input: 100_000, at: 16 * 60 * MINUTE, cacheRead: 0 })
    )
    expect(miss?.gapMs).toBe(8 * 60 * MINUTE)

    const backwards = createCacheMissTracker()
    backwards.observe(message({ input: 10_000, cacheWrite: 90_000, at: 5 * MINUTE }))
    expect(backwards.observe(message({ input: 100_000, at: 0 }))?.gapMs).toBe(0)
  })

  it('counts a model switch rather than exempting it', () => {
    const tracker = createCacheMissTracker()
    tracker.observe(message({ input: 10_000, cacheWrite: 90_000 }))
    const miss = tracker.observe(message({ input: 100_000, model: 'claude-sonnet-5' }))

    // A switch re-bills the full prompt, so it is exactly what should count.
    expect(miss?.missedTokens).toBe(100_000)
    expect(miss?.modelChanged).toBe(true)
  })

  it('starts the comparison over after a compaction or a branch summary', () => {
    const tracker = createCacheMissTracker()
    tracker.observe(message({ input: 10_000, cacheWrite: 90_000 }))
    tracker.contextReset()
    // The context legitimately changed: this prompt is new content, not
    // re-billed content.
    expect(tracker.observe(message({ input: 100_000 }))).toBeUndefined()
  })

  it('leaves the previous request standing when a message billed no prompt', () => {
    expect(billsPrompt(message({ input: 0 }))).toBe(false)
    expect(billsPrompt(message({ input: 1 }))).toBe(true)

    const tracker = createCacheMissTracker()
    tracker.observe(message({ input: 10_000, cacheWrite: 90_000, at: 0 }))
    tracker.observe(message({ at: MINUTE }))
    // Compared against the turn that really billed one, an hour earlier.
    const miss = tracker.observe(message({ input: 100_000, at: 60 * MINUTE }))
    expect(miss?.gapMs).toBe(60 * MINUTE)
  })
})

describe('scanning a whole conversation', () => {
  it('totals what was re-billed and says which entry paid for each miss', () => {
    const scan = scanCacheMisses([
      { kind: 'other' },
      assistant(message({ input: 10_000, cacheWrite: 90_000, costCacheWrite: 1.5 })),
      { kind: 'other' },
      assistant(message({ input: 100_000, costInput: 1.5 })),
      { kind: 'contextReset' },
      assistant(message({ input: 10_000, cacheWrite: 90_000, costCacheWrite: 1.5 })),
      assistant(message({ input: 100_000, costInput: 1.5 }))
    ])

    expect(scan.totals.count).toBe(2)
    expect(scan.totals.tokens).toBe(200_000)
    expect(scan.totals.dollars).toBeCloseTo(3, 4)
    // The index names the caller's own entry, which is how a seam lands above
    // the message that paid for it.
    expect(scan.misses.map((found) => found.at)).toEqual([3, 6])
  })

  it('hands back a tracker positioned after everything it read', () => {
    const scan = scanCacheMisses([
      assistant(message({ input: 10_000, cacheWrite: 90_000, at: 0 }))
    ])

    // This is how a restored conversation goes on counting: the history is
    // scanned, and the next completed message is compared against it.
    const next = scan.tracker.observe(message({ input: 100_000, at: 5 * MINUTE }))
    expect(next?.missedTokens).toBe(100_000)
    expect(next?.gapMs).toBe(5 * MINUTE)
  })
})
