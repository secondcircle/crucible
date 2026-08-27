// @vitest-environment node
//
// Written as a consumer that asks questions and never pays for one. Every
// test passes a fixture directory, so none can reach the machine's own cache.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cannedQuotaSnapshot } from '../../shared/quota/fake-service'
import type { QuotaMeter, QuotaSnapshot } from '../../shared/quota/types'
import {
  isStale,
  MAX_USABLE_AGE_MS,
  readQuota,
  STALE_AFTER_MS,
  worstUsedPercent
} from './reader'

const MINUTE = 60 * 1000
const NOW = Date.UTC(2026, 7, 15, 12, 0, 0)
/** The month NOW sits in closes here, which is what a spend meter resets on. */
const MONTH_END = Date.UTC(2026, 8, 1)

const directories: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crucible-quota-reader-'))
  directories.push(dir)
  return dir
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop() as string, { recursive: true, force: true })
  }
})

function meter(over: Partial<QuotaMeter> = {}): QuotaMeter {
  return { kind: 'weekly', label: '7D', usedPercent: 20, resetsAt: null, ...over }
}

/** The work account's meter, as the Anthropic adapter parses it. */
function spendMeter(over: Partial<QuotaMeter> = {}): QuotaMeter {
  return {
    kind: 'monthly',
    label: 'MO',
    usedPercent: 42.3852,
    resetsAt: MONTH_END,
    usedDollars: 2119.26,
    limitDollars: 5000,
    ...over
  }
}

/** Writes a cache file the way the store writes one, or as damaged as asked. */
function writeCache(dir: string, providerId: string, entry: Record<string, unknown>): void {
  writeFileSync(join(dir, `${providerId}.json`), JSON.stringify(entry))
}

function goodEntry(
  providerId: string,
  windows: QuotaMeter[],
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return { v: 1, providerId, windows, fetchedAt: NOW, attemptedAt: NOW, ...over }
}

function snapshotOf(dir: string, now: number = NOW): QuotaSnapshot {
  return readQuota({ dir, now: () => now })
}

describe('the quota reader', () => {
  it('reads an empty snapshot on a machine where nothing has ever fetched', () => {
    expect(snapshotOf(tempDir())).toEqual({ providers: {}, fetchedAt: NOW })
  })

  it('drops a lapsed meter rather than dimming it, and discards its percent', () => {
    const dir = tempDir()
    writeCache(
      dir,
      'anthropic',
      goodEntry('anthropic', [
        meter({ kind: 'session', label: '5H', usedPercent: 99, resetsAt: NOW - MINUTE }),
        meter({ usedPercent: 54, resetsAt: NOW + MINUTE }),
        meter({ kind: 'weekly_scoped', label: 'FABLE', usedPercent: 42, resetsAt: null })
      ])
    )

    // A rolled-over percent is wrong rather than merely old, and it is the one
    // failure that looks exactly like a reading.
    expect(snapshotOf(dir).providers.anthropic.meters.map((shown) => shown.label)).toEqual([
      '7D',
      'FABLE'
    ])
  })

  it('keeps a provider whose every meter lapsed, present and empty', () => {
    const dir = tempDir()
    writeCache(dir, 'xai', goodEntry('xai', [meter({ usedPercent: 61, resetsAt: NOW - MINUTE })]))

    const quota = snapshotOf(dir).providers.xai
    expect(quota).toBeDefined()
    expect(quota.meters).toEqual([])
  })

  it('reads a wrong schema version, a truncated file and junk as absent', () => {
    const dir = tempDir()
    writeCache(dir, 'anthropic', goodEntry('anthropic', [meter()], { v: 2 }))
    writeFileSync(join(dir, 'xai.json'), '{"v":1,"providerId":"xai","win')
    writeFileSync(join(dir, 'openai-codex.json'), 'not json at all')

    expect(snapshotOf(dir).providers).toEqual({})
  })

  it('keeps the valid meters of a partly invalid file', () => {
    const dir = tempDir()
    writeCache(dir, 'xai', {
      v: 1,
      providerId: 'xai',
      fetchedAt: NOW,
      attemptedAt: NOW,
      windows: [
        { kind: 'weekly', label: '7D', usedPercent: 20, resetsAt: null },
        { kind: 'invented', label: 'X', usedPercent: 5, resetsAt: null },
        { kind: 'weekly', label: '', usedPercent: 5, resetsAt: null },
        { kind: 'weekly', label: 'BIG', usedPercent: 101, resetsAt: null }
      ]
    })

    expect(snapshotOf(dir).providers.xai.meters).toEqual([meter()])
  })

  it('publishes only providers that could have an adapter', () => {
    const dir = tempDir()
    writeCache(dir, 'anthropic', goodEntry('anthropic', [meter()]))
    writeCache(dir, 'some-future-provider', goodEntry('some-future-provider', [meter()]))

    // No store has run here to prune the residue, and the snapshot is right
    // anyway: absence is the reader's property, not timing's.
    expect(Object.keys(snapshotOf(dir).providers)).toEqual(['anthropic'])
  })

  it('calls a reading stale at exactly the age the strip dims it', () => {
    const fresh = { providerId: 'xai', meters: [meter()], fetchedAt: NOW }

    expect(isStale(fresh, NOW + STALE_AFTER_MS - 1)).toBe(false)
    expect(isStale(fresh, NOW + STALE_AFTER_MS)).toBe(true)
  })

  it('calls a reading stale the moment an attempt over it fails, however young', () => {
    const failed = {
      providerId: 'xai',
      meters: [meter()],
      fetchedAt: NOW,
      error: 'unavailable' as const
    }

    expect(isStale(failed, NOW)).toBe(true)
  })

  it('answers the worst live percent, in used, or null when it cannot know', () => {
    const dir = tempDir()
    writeCache(
      dir,
      'anthropic',
      goodEntry('anthropic', [
        meter({ kind: 'session', label: '5H', usedPercent: 73, resetsAt: NOW + MINUTE }),
        meter({ usedPercent: 29, resetsAt: NOW + MINUTE })
      ])
    )
    const snapshot = snapshotOf(dir)

    expect(worstUsedPercent(snapshot, 'anthropic', NOW)).toBe(73)
    // No credential, nothing cached: unknown, and unknown is never a zero.
    expect(worstUsedPercent(snapshot, 'xai', NOW)).toBeNull()
  })

  it('refuses to answer with a stale reading, or with lapsed meters', () => {
    const dir = tempDir()
    writeCache(dir, 'xai', goodEntry('xai', [meter({ usedPercent: 61, resetsAt: NOW + MINUTE })]))

    // Fresh: a number.
    expect(worstUsedPercent(snapshotOf(dir), 'xai', NOW)).toBe(61)
    // Aged past the boundary: unknown, never a hundred and never a zero.
    const aged = NOW + STALE_AFTER_MS
    expect(worstUsedPercent(snapshotOf(dir, aged), 'xai', aged)).toBeNull()
    // Every meter lapsed: unknown again, and the row would show a dash.
    const later = NOW + 2 * MINUTE
    expect(worstUsedPercent(snapshotOf(dir, later), 'xai', later)).toBeNull()
  })

  it('holds the two freshness boundaries the strip draws against', () => {
    // Defined once and shared, so the store, the reader and the strip cannot
    // disagree about the word "stale".
    expect(STALE_AFTER_MS).toBe(5 * 60 * 1000)
    expect(MAX_USABLE_AGE_MS).toBe(60 * 60 * 1000)
  })

  it('carries a failed attempt through to the record without losing the meters', () => {
    const dir = tempDir()
    writeCache(
      dir,
      'xai',
      goodEntry('xai', [meter({ usedPercent: 61 })], { error: 'unauthorized' })
    )

    const quota = snapshotOf(dir).providers.xai
    expect(quota.error).toBe('unauthorized')
    expect(quota.meters).toEqual([meter({ usedPercent: 61 })])
  })
})

// This gate is where the work account's row went dark: the kind was not in the
// allow-list and the dollars were dropped from the kinds that were.
describe('the spend meter through the cache gate', () => {
  it('reads a cached monthly meter back whole, dollars included', () => {
    const dir = tempDir()
    writeCache(dir, 'anthropic', goodEntry('anthropic', [spendMeter()]))

    expect(snapshotOf(dir).providers.anthropic.meters).toEqual([spendMeter()])
  })

  it('drops a monthly meter whose dollars it cannot trust, and keeps the row’s others', () => {
    const dir = tempDir()
    const survivor = meter({ usedPercent: 29, resetsAt: NOW + MINUTE })
    const untrustworthy: Array<Record<string, unknown>> = [
      {},
      { usedDollars: 2119.26 },
      { limitDollars: 5000 },
      { usedDollars: -0.01, limitDollars: 5000 },
      { usedDollars: 2119.26, limitDollars: 0 },
      { usedDollars: 2119.26, limitDollars: -5000 },
      { usedDollars: '2119.26', limitDollars: 5000 }
    ]

    for (const dollars of untrustworthy) {
      writeCache(dir, 'anthropic', {
        v: 1,
        providerId: 'anthropic',
        fetchedAt: NOW,
        attemptedAt: NOW,
        windows: [
          { kind: 'monthly', label: 'MO', usedPercent: 42.3852, resetsAt: MONTH_END, ...dollars },
          survivor
        ]
      })

      // Never percent-only and never with a zero filled in: an amount this
      // process invented would read exactly like one somebody spent.
      expect(snapshotOf(dir).providers.anthropic.meters).toEqual([survivor])
    }
  })

  it('drops a monthly meter carrying a non-finite amount, either side of it', () => {
    const dir = tempDir()
    // A JSON file cannot hold a bare `NaN`, but `1e999` parses as Infinity,
    // which would print as a 0% budget or a `$Infinityk` spend.
    writeFileSync(
      join(dir, 'anthropic.json'),
      `{"v":1,"providerId":"anthropic","fetchedAt":${NOW},"attemptedAt":${NOW},"windows":[` +
        '{"kind":"monthly","label":"MO","usedPercent":42,"resetsAt":null,' +
        '"usedDollars":2119.26,"limitDollars":1e999},' +
        '{"kind":"monthly","label":"MO","usedPercent":42,"resetsAt":null,' +
        '"usedDollars":1e999,"limitDollars":5000}]}'
    )

    expect(snapshotOf(dir).providers.anthropic.meters).toEqual([])
  })

  it('never publishes dollars smuggled onto a meter of another kind', () => {
    const dir = tempDir()
    writeCache(dir, 'anthropic', {
      v: 1,
      providerId: 'anthropic',
      fetchedAt: NOW,
      attemptedAt: NOW,
      windows: [
        { kind: 'weekly', label: '7D', usedPercent: 20, resetsAt: null, usedDollars: 40, limitDollars: 100 }
      ]
    })

    const [shown] = snapshotOf(dir).providers.anthropic.meters
    expect(shown).toEqual(meter())
    expect(Object.keys(shown)).not.toContain('usedDollars')
  })

  it('answers the monthly percent as the worst on a work account, being a real number', () => {
    const dir = tempDir()
    writeCache(dir, 'anthropic', goodEntry('anthropic', [spendMeter()]))

    // Derived from two real amounts, so it is a reading rather than a guess.
    expect(worstUsedPercent(snapshotOf(dir), 'anthropic', NOW)).toBeCloseTo(42.3852, 4)
  })

  it('reads every canned meter back exactly, so the fake flavor cannot diverge', () => {
    const dir = tempDir()
    const canned = cannedQuotaSnapshot(NOW)

    for (const quota of Object.values(canned.providers)) {
      writeCache(dir, quota.providerId, goodEntry(quota.providerId, [...quota.meters]))
    }

    // The fake flavor hands the renderer this snapshot without ever crossing
    // this gate, so a shape the fake shows must be one the reader publishes.
    const read = snapshotOf(dir)
    for (const quota of Object.values(canned.providers)) {
      expect(read.providers[quota.providerId].meters).toEqual(quota.meters)
    }
  })
})
