// @vitest-environment node
//
// The display formats on their own: what the strip, the dialog and the seam
// say, without a component anywhere near them.
import { describe, expect, it } from 'vitest'
import type { CacheMissFacts } from '../../../shared/agent/port'
import {
  compactTokens,
  gapText,
  homePath,
  missesText,
  moneyText,
  retentionSource,
  retentionText,
  seamFacts,
  spanStart,
  spanStartFull,
  stripLabel
} from './format'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Local time, because that is the clock the strip prints. */
function at(
  year: number,
  month: number,
  day: number,
  hour = 15,
  minute = 4
): { iso: string; ms: number } {
  const when = new Date(year, month, day, hour, minute, 0, 0)
  return { iso: when.toISOString(), ms: when.getTime() }
}

function miss(over: Partial<CacheMissFacts> = {}): CacheMissFacts {
  return {
    tokensRebilled: 118_211,
    dollarsRebilled: 0.62,
    gapMs: 8 * HOUR,
    modelChanged: 'no',
    thinkingChanged: 'no',
    jump: 'no',
    retention: '5m',
    ...over
  }
}

describe('what the strip says', () => {
  it('counts in the singular where there is one', () => {
    expect(missesText(0)).toBe('0 misses')
    expect(missesText(1)).toBe('1 miss')
    expect(missesText(9)).toBe('9 misses')
  })

  it('omits the money at zero, and prints two decimals otherwise', () => {
    expect(moneyText(0, 0)).toBe('')
    expect(moneyText(9, 2.8)).toBe('$2.80 re-billed')
    expect(moneyText(1, 0.6249)).toBe('$0.62 re-billed')
  })

  it('always states the span the count covers', () => {
    const tuesday = at(2026, 7, 18, 15, 4)
    // Within the week: the weekday and the hour, which is what a person
    // remembers doing.
    expect(spanStart(tuesday.iso, tuesday.ms + 2 * DAY)).toBe('Tue 3pm')
    // Past it: the date. Past a year: the year with it.
    expect(spanStart(tuesday.iso, tuesday.ms + 20 * DAY)).toBe('Aug 18')
    expect(spanStart(tuesday.iso, tuesday.ms + 400 * DAY)).toBe('Aug 18 2026')
  })

  it('says the same instant to the minute where the dialog has room', () => {
    const tuesday = at(2026, 7, 18, 15, 4)
    expect(spanStartFull(tuesday.iso, tuesday.ms + 2 * DAY)).toBe('Tue 3:04pm')
    expect(spanStartFull(tuesday.iso, tuesday.ms + 20 * DAY)).toBe('Aug 18 3:04pm')
  })

  it('names itself by the count and the span it covers', () => {
    expect(stripLabel(9)).toBe('Cache health — 9 misses since your last reset')
    expect(stripLabel(1)).toBe('Cache health — 1 miss since your last reset')
  })
})

describe('what the seam says', () => {
  it('uses π\u2019s own compact token form', () => {
    expect(compactTokens(940)).toBe('940')
    expect(compactTokens(4_210)).toBe('4.2k')
    expect(compactTokens(118_211)).toBe('118k')
    expect(compactTokens(2_400_000)).toBe('2.4M')
  })

  it('says the gap in the largest unit that still means something', () => {
    expect(gapText(-5)).toBe('0s')
    expect(gapText(42 * 1000)).toBe('42s')
    expect(gapText(9 * MINUTE)).toBe('9m')
    expect(gapText(8 * HOUR)).toBe('8h')
    expect(gapText(5 * DAY)).toBe('5d')
  })

  it('states the facts in the ruled order, money included past a cent', () => {
    expect(seamFacts(miss())).toEqual([
      '118k tokens re-billed (+$0.62)',
      '8h since previous turn',
      'model unchanged',
      'thinking unchanged',
      'retention 5 min'
    ])
  })

  it('drops the parenthetical below a cent, as π\u2019s own notice does', () => {
    expect(seamFacts(miss({ dollarsRebilled: 0.004 }))[0]).toBe('118k tokens re-billed')
  })

  it('omits an unknown fact rather than guessing it', () => {
    const facts = seamFacts(miss({ modelChanged: 'unknown', thinkingChanged: 'unknown' }))

    expect(facts).toEqual([
      '118k tokens re-billed (+$0.62)',
      '8h since previous turn',
      'retention 5 min'
    ])
  })

  it('says what changed where Crucible knows it changed', () => {
    const facts = seamFacts(
      miss({ modelChanged: 'yes', thinkingChanged: 'yes', jump: 'yes', retention: '1h' })
    )

    expect(facts).toContain('model changed')
    expect(facts).toContain('thinking changed')
    expect(facts).toContain('retention 1 hour')
    // A jump is one more fact, appended to the rest.
    expect(facts.at(-1)).toBe('after a jump')
  })

  it('never names a cause', () => {
    const said = seamFacts(miss({ modelChanged: 'yes' })).join(' ')
    expect(said.toLowerCase()).not.toContain('cause')
    expect(said.toLowerCase()).not.toContain('because')
  })
})

describe('the ledger path', () => {
  it('shortens the home directory so the rest of it renders whole', () => {
    expect(homePath('/Users/ike/Library/Application Support/Crucible/cache-misses.jsonl')).toBe(
      '~/Library/Application Support/Crucible/cache-misses.jsonl'
    )
    // Anything outside a home directory is shown exactly as it is.
    expect(homePath('/var/lib/crucible/cache-misses.jsonl')).toBe(
      '/var/lib/crucible/cache-misses.jsonl'
    )
  })
})

describe('the retention in force', () => {
  it('reads as the setting, and says where the setting came from', () => {
    expect(retentionText('5m')).toBe('5 min')
    expect(retentionText('1h')).toBe('1 hour')
    expect(retentionSource('5m')).toBe('π default')
    expect(retentionSource('1h')).toBe('PI_CACHE_RETENTION=long')
  })
})
