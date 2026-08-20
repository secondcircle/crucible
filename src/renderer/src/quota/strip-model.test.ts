// @vitest-environment node
//
// The arithmetic behind the strip is pure, so none of it needs a document to
// be tested.
import { describe, expect, it } from 'vitest'
import type { QuotaMeter, QuotaSnapshot } from '../../../shared/quota/types'
import {
  ageText,
  countdownText,
  crossingAt,
  levelOf,
  outWord,
  paceFraction,
  providerName,
  quotaRows
} from './strip-model'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const NOW = Date.UTC(2026, 7, 15, 12, 0, 0)

function meter(over: Partial<QuotaMeter> = {}): QuotaMeter {
  return { kind: 'weekly', label: '7D', usedPercent: 20, resetsAt: null, ...over }
}

/** A weekly meter this far into its window, at this percent. */
function weekly(elapsed: number, usedPercent: number, over: Partial<QuotaMeter> = {}): QuotaMeter {
  return meter({ usedPercent, resetsAt: NOW - elapsed + WEEK, ...over })
}

function snapshotOf(
  providers: Record<string, { meters: QuotaMeter[]; fetchedAt?: number; error?: 'unavailable' }>
): QuotaSnapshot {
  return {
    fetchedAt: NOW,
    providers: Object.fromEntries(
      Object.entries(providers).map(([providerId, quota]) => [
        providerId,
        {
          providerId,
          meters: quota.meters,
          fetchedAt: quota.fetchedAt ?? NOW,
          ...(quota.error === undefined ? {} : { error: quota.error })
        }
      ])
    )
  }
}

describe('the countdown', () => {
  it('prints minutes under an hour, hours under a day, and days above', () => {
    expect(countdownText(NOW + 9 * MINUTE, NOW)).toBe('⟳<9m')
    expect(countdownText(NOW + 3 * HOUR + 7 * MINUTE, NOW)).toBe('⟳3h07')
    expect(countdownText(NOW + 4 * DAY + 11 * HOUR, NOW)).toBe('⟳4d11')
  })

  it('prints nothing at or past the reset, because "now" is not a countdown', () => {
    expect(countdownText(NOW, NOW)).toBe('')
    expect(countdownText(NOW - MINUTE, NOW)).toBe('')
  })
})

describe('the age of a dimmed reading', () => {
  it('floors to whole minutes, and says <1m rather than a rounded-down lie', () => {
    expect(ageText(12 * MINUTE)).toBe('·12m')
    expect(ageText(12 * MINUTE + 59_000)).toBe('·12m')
    expect(ageText(30_000)).toBe('·<1m')
    expect(ageText(0)).toBe('·<1m')
  })
})

describe('the color thresholds', () => {
  it('reads the exact percent at 70 and at 90', () => {
    expect(levelOf(69.9)).toBe('normal')
    expect(levelOf(70)).toBe('warn')
    expect(levelOf(89.9)).toBe('warn')
    expect(levelOf(90)).toBe('crit')
  })

  it('rounds the printed digits only, so 89.6 prints 90% and is still amber', () => {
    const rows = quotaRows(snapshotOf({ xai: { meters: [meter({ usedPercent: 89.6 })] } }), NOW)

    expect(rows[0].meters[0].text).toBe('90%')
    expect(rows[0].meters[0].level).toBe('warn')
    // The fill is the payload's own number, not the printed one.
    expect(rows[0].meters[0].fillPercent).toBe(89.6)
  })

  it('marks a red number with a ! so the alarm survives greyscale', () => {
    const rows = quotaRows(snapshotOf({ xai: { meters: [meter({ usedPercent: 91 })] } }), NOW)

    expect(rows[0].meters[0].text).toBe('!91%')
    expect(rows[0].meters[0].level).toBe('crit')
  })
})

describe('pace', () => {
  it('puts the tick at the elapsed fraction of the week', () => {
    expect(paceFraction(weekly(3.5 * DAY, 10), NOW)).toBeCloseTo(0.5, 6)
    expect(paceFraction(weekly(61 * HOUR, 29), NOW)).toBeCloseTo(0.363, 3)
  })

  it('says nothing at all in the first day of a window', () => {
    expect(paceFraction(weekly(23 * HOUR, 40), NOW)).toBeNull()
    expect(crossingAt(weekly(23 * HOUR, 40), NOW)).toBeNull()
    // The measured percent still shows; only the pace goes quiet.
    const rows = quotaRows(snapshotOf({ xai: { meters: [weekly(23 * HOUR, 40)] } }), NOW)
    expect(rows[0].meters[0].tickPercent).toBeUndefined()
    expect(rows[0].meters[0].text).toBe('40%')
    expect(rows[0].outWord).toBeUndefined()
  })

  it('never paces a session meter or a meter with no reset instant', () => {
    expect(paceFraction(meter({ kind: 'session', label: '5H', resetsAt: NOW + HOUR }), NOW)).toBeNull()
    expect(paceFraction(meter({ resetsAt: null }), NOW)).toBeNull()
  })

  it('paces a scoped weekly meter exactly as it paces the plain one', () => {
    const scoped = weekly(3.5 * DAY, 60, { kind: 'weekly_scoped', label: 'FABLE' })

    expect(paceFraction(scoped, NOW)).toBeCloseTo(0.5, 6)
  })

  it('gives the out-word exactly when used ÷ elapsed lands past 100', () => {
    // Half the week gone, 50% spent: dead on the pace, and nothing is said.
    expect(outWord([weekly(3.5 * DAY, 50)], NOW)).toBeUndefined()
    // Half the week gone, 51% spent: past it, so the word appears.
    expect(outWord([weekly(3.5 * DAY, 51)], NOW)).toMatch(/^out /)
    // Nothing spent at all cannot project anything.
    expect(outWord([weekly(3.5 * DAY, 0)], NOW)).toBeUndefined()
  })

  it('names the weekday of the crossing instant', () => {
    // 92 h into the week at 78%: the straight line hits 100% about 26 h from
    // now, and the word names that day.
    const codex = weekly(92 * HOUR, 78)
    const crossing = crossingAt(codex, NOW) as number

    expect(crossing).toBeGreaterThan(NOW)
    expect(crossing).toBeLessThan(codex.resetsAt as number)
    expect(outWord([codex], NOW)).toBe(
      `out ${new Date(crossing).toLocaleDateString(undefined, { weekday: 'short' })}`
    )
  })

  it('lets the earliest crossing win when several meters project past 100', () => {
    const sooner = weekly(6 * DAY, 99, { kind: 'weekly_scoped', label: 'FABLE' })
    const later = weekly(4 * DAY, 80)
    const first = Math.min(crossingAt(sooner, NOW) as number, crossingAt(later, NOW) as number)

    expect(outWord([later, sooner], NOW)).toBe(
      `out ${new Date(first).toLocaleDateString(undefined, { weekday: 'short' })}`
    )
  })
})

describe('the rows', () => {
  it('is empty without a snapshot, which is what no quota service looks like', () => {
    expect(quotaRows(undefined, NOW)).toEqual([])
    expect(quotaRows({ providers: {}, fetchedAt: NOW }, NOW)).toEqual([])
  })

  it('orders providers alphabetically by the name it shows', () => {
    const rows = quotaRows(
      snapshotOf({
        xai: { meters: [meter()] },
        'openai-codex': { meters: [meter()] },
        anthropic: { meters: [meter()] }
      }),
      NOW
    )

    expect(rows.map((row) => row.name)).toEqual(['Anthropic', 'Codex', 'Grok'])
    // An id Crucible does not know displays as itself and sorts with the rest.
    expect(providerName('some-future-provider')).toBe('some-future-provider')
  })

  it('shows the meters in kind order, whatever order the payload had', () => {
    const rows = quotaRows(
      snapshotOf({
        anthropic: {
          meters: [
            meter({ kind: 'weekly_scoped', label: 'FABLE', usedPercent: 22 }),
            meter({ kind: 'weekly', label: '7D', usedPercent: 29 }),
            meter({ kind: 'session', label: '5H', usedPercent: 73 })
          ]
        }
      }),
      NOW
    )

    expect(rows[0].meters.map((shown) => shown.label)).toEqual(['5H', '7D', 'FABLE'])
  })

  it('counts down to the longest live reset, which is the weekly one', () => {
    const rows = quotaRows(
      snapshotOf({
        anthropic: {
          meters: [
            meter({ kind: 'session', label: '5H', resetsAt: NOW + 3 * HOUR + 7 * MINUTE }),
            meter({ resetsAt: NOW + 4 * DAY + 11 * HOUR })
          ]
        }
      }),
      NOW
    )

    expect(rows[0].right).toBe('⟳4d11')
  })

  it('drops a lapsed meter, and drops the row to unknown when they all lapse', () => {
    const rows = quotaRows(
      snapshotOf({
        anthropic: {
          meters: [
            meter({ kind: 'session', label: '5H', usedPercent: 99, resetsAt: NOW - MINUTE }),
            meter({ usedPercent: 29, resetsAt: NOW + DAY })
          ]
        },
        xai: { meters: [meter({ usedPercent: 61, resetsAt: NOW - MINUTE })] }
      }),
      NOW
    )

    expect(rows[0].meters.map((shown) => shown.label)).toEqual(['7D'])
    expect(rows[1]).toMatchObject({ name: 'Grok', state: 'unknown', right: '', meters: [] })
  })

  it('hides a scoped meter at zero the provider does not call binding', () => {
    const rows = quotaRows(
      snapshotOf({
        anthropic: {
          meters: [
            meter({ kind: 'weekly', label: '7D', usedPercent: 29 }),
            meter({ kind: 'weekly_scoped', label: 'FABLE', usedPercent: 0 }),
            meter({ kind: 'weekly_scoped', label: 'SPARK', usedPercent: 0, isActive: true })
          ]
        }
      }),
      NOW
    )

    // A plan feature the account has never used is not a permanent empty bar;
    // the moment it shows use or the provider calls it binding, it appears.
    expect(rows[0].meters.map((shown) => shown.label)).toEqual(['7D', 'SPARK'])
  })

  it('dims a stale row, shows its age instead of the countdown, and drops the emphasis', () => {
    const rows = quotaRows(
      snapshotOf({
        anthropic: {
          fetchedAt: NOW - 12 * MINUTE,
          meters: [
            meter({ kind: 'session', label: '5H', usedPercent: 91, resetsAt: NOW + DAY }),
            weekly(4 * DAY, 80)
          ]
        }
      }),
      NOW
    )

    expect(rows[0].state).toBe('stale')
    expect(rows[0].right).toBe('·12m')
    expect(rows[0].meters.map((shown) => shown.text)).toEqual(['91%', '80%'])
    expect(rows[0].meters.every((shown) => shown.level === 'normal')).toBe(true)
    // The tick is a clock fact and stays; the projection needs a number the
    // strip trusts, so the word goes.
    expect(rows[0].meters[1].tickPercent).toBeCloseTo(57.1, 1)
    expect(rows[0].outWord).toBeUndefined()
  })

  it('calls a failed attempt over a reading stale however young the reading is', () => {
    const rows = quotaRows(
      snapshotOf({ xai: { meters: [meter()], error: 'unavailable' } }),
      NOW + 1000
    )

    expect(rows[0].state).toBe('stale')
    expect(rows[0].right).toBe('·<1m')
  })

  it('drops a reading past an hour to a dash, never a stale number', () => {
    const rows = quotaRows(
      snapshotOf({
        xai: { fetchedAt: NOW - 61 * MINUTE, meters: [meter({ usedPercent: 61 })] }
      }),
      NOW
    )

    expect(rows[0]).toMatchObject({ name: 'Grok', state: 'unknown', right: '', meters: [] })
  })

  it('leaves one provider\u2019s trouble entirely out of another\u2019s row', () => {
    const rows = quotaRows(
      snapshotOf({
        anthropic: { fetchedAt: NOW - 90 * MINUTE, meters: [meter()] },
        xai: { meters: [meter({ usedPercent: 19, resetsAt: NOW + 5 * DAY })] }
      }),
      NOW
    )

    expect(rows[0].state).toBe('unknown')
    expect(rows[1]).toMatchObject({ name: 'Grok', state: 'ok' })
    expect(rows[1].meters[0].text).toBe('19%')
  })
})
