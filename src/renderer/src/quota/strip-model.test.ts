// @vitest-environment node
//
// The arithmetic behind the strip is pure, so none of it needs a document to
// be tested.
import { describe, expect, it } from 'vitest'
import { monthlyResetAfter, monthWindowStart } from '../../../shared/quota/month'
import type { QuotaMeter, QuotaSnapshot } from '../../../shared/quota/types'
import {
  ageText,
  countdownText,
  crossingAt,
  dollarText,
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

/** The month this file's "now" sits in: 1 September, and the 31 days behind it. */
const MONTH_END = monthlyResetAfter(NOW)
const MONTH_MS = MONTH_END - monthWindowStart(MONTH_END)

function meter(over: Partial<QuotaMeter> = {}): QuotaMeter {
  return { kind: 'weekly', label: '7D', usedPercent: 20, resetsAt: null, ...over }
}

/** A weekly meter this far into its window, at this percent. */
function weekly(elapsed: number, usedPercent: number, over: Partial<QuotaMeter> = {}): QuotaMeter {
  return meter({ usedPercent, resetsAt: NOW - elapsed + WEEK, ...over })
}

/** The work account's meter: a dollar budget on the calendar month. */
function monthly(usedDollars: number, limitDollars = 5000, resetsAt = MONTH_END): QuotaMeter {
  return {
    kind: 'monthly',
    label: 'MO',
    usedPercent: Math.min(100, (usedDollars / limitDollars) * 100),
    resetsAt,
    usedDollars,
    limitDollars
  }
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

  it('paces a monthly meter over its own calendar month, not over a week', () => {
    // Mid-August: 14.5 of August's 31 days are gone.
    expect(paceFraction(monthly(2119.26), NOW)).toBeCloseTo((14.5 * DAY) / MONTH_MS, 6)
    // February's window is three days shorter, so the same elapsed time is a
    // larger fraction of it.
    const february = Date.UTC(2026, 2, 1)
    const midFebruary = Date.UTC(2026, 1, 15, 12, 0, 0)
    expect(paceFraction(monthly(2119.26, 5000, february), midFebruary)).toBeCloseTo(
      (14.5 * DAY) / (28 * DAY),
      6
    )
  })

  it('stays quiet through the first day of a month, like any other window', () => {
    const justOpened = Date.UTC(2026, 8, 1, 12, 0, 0)
    const monthEnd = monthlyResetAfter(justOpened)

    expect(paceFraction(monthly(400, 5000, monthEnd), justOpened)).toBeNull()
    expect(crossingAt(monthly(400, 5000, monthEnd), justOpened)).toBeNull()
    // A day and an hour in, it speaks.
    expect(paceFraction(monthly(400, 5000, monthEnd), justOpened + DAY + HOUR)).not.toBeNull()
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

  it('names the month and day of a crossing further out than a week', () => {
    // A month at 60% with under half of it elapsed: the line crosses 100% weeks
    // away, where a bare weekday would not say which week.
    const distant = monthly(3000, 5000, Date.UTC(2026, 9, 1))
    const early = Date.UTC(2026, 8, 12, 12, 0, 0)
    const crossing = crossingAt(distant, early) as number

    expect(crossing - early).toBeGreaterThan(7 * DAY)
    expect(outWord([distant], early)).toBe(
      `out ${new Date(crossing).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
    )
    expect(outWord([distant], early)).toMatch(/^out [A-Z][a-z]{2} \d{1,2}$/)
  })

  it('keeps the weekday for a crossing inside the week, monthly meter or not', () => {
    const soon = monthly(4600, 5000, MONTH_END)
    const crossing = crossingAt(soon, NOW) as number

    expect(crossing - NOW).toBeLessThan(7 * DAY)
    expect(outWord([soon], NOW)).toBe(
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

describe('the monthly meter\u2019s dollars', () => {
  it('prints thousands above a thousand, dropping a whole decimal', () => {
    expect(dollarText(2119.26)).toBe('$2.1k')
    expect(dollarText(5000)).toBe('$5k')
    expect(dollarText(1050)).toBe('$1.1k')
    expect(dollarText(12000)).toBe('$12k')
  })

  it('prints whole dollars above a hundred, or where the amount is whole', () => {
    expect(dollarText(211)).toBe('$211')
    expect(dollarText(42)).toBe('$42')
    expect(dollarText(0)).toBe('$0')
  })

  it('prints cents below that, and no more than two of them', () => {
    expect(dollarText(0.37)).toBe('$0.37')
    expect(dollarText(0.375)).toBe('$0.38')
    expect(dollarText(37.5)).toBe('$37.5')
  })

  it('reads as spent over budget with the percent beside it', () => {
    const rows = quotaRows(snapshotOf({ anthropic: { meters: [monthly(2119.26)] } }), NOW)

    expect(rows[0].meters[0].text).toBe('$2.1k/$5k · 42%')
    expect(rows[0].meters[0].label).toBe('MO')
    expect(rows[0].meters[0].level).toBe('normal')
  })

  it('leads with a ! at the crit threshold, as every other meter does', () => {
    const rows = quotaRows(snapshotOf({ anthropic: { meters: [monthly(4700)] } }), NOW)

    expect(rows[0].meters[0].text).toBe('!$4.7k/$5k · 94%')
    expect(rows[0].meters[0].level).toBe('crit')
  })

  it('prints an overage while the fill pins at a full budget', () => {
    const rows = quotaRows(snapshotOf({ anthropic: { meters: [monthly(5200)] } }), NOW)

    // The bar cannot draw past its end; the number must not lie about it.
    expect(rows[0].meters[0].text).toBe('!$5.2k/$5k · 104%')
    expect(rows[0].meters[0].fillPercent).toBe(100)
  })

  it('takes its colour from the same two thresholds, never from pace', () => {
    const level = (used: number): string =>
      quotaRows(snapshotOf({ anthropic: { meters: [monthly(used)] } }), NOW)[0].meters[0].level

    expect(level(3499)).toBe('normal')
    expect(level(3500)).toBe('warn')
    expect(level(4500)).toBe('crit')
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

  it('ranks the monthly meter last, whatever order the payload had', () => {
    const rows = quotaRows(
      snapshotOf({
        anthropic: {
          meters: [
            monthly(2119.26),
            meter({ kind: 'weekly_scoped', label: 'FABLE', usedPercent: 22 }),
            meter({ kind: 'session', label: '5H', usedPercent: 73 }),
            meter({ kind: 'weekly', label: '7D', usedPercent: 29 })
          ]
        }
      }),
      NOW
    )

    expect(rows[0].meters.map((shown) => shown.label)).toEqual(['5H', '7D', 'FABLE', 'MO'])
  })

  it('counts down to the monthly reset, which outlasts every other meter', () => {
    const rows = quotaRows(
      snapshotOf({
        anthropic: {
          meters: [
            meter({ kind: 'session', label: '5H', resetsAt: NOW + 3 * HOUR }),
            weekly(3 * DAY, 29),
            monthly(2119.26)
          ]
        }
      }),
      NOW
    )

    expect(rows[0].right).toBe(countdownText(MONTH_END, NOW))
    expect(rows[0].right).toBe('⟳16d12')
  })

  it('drops a lapsed monthly meter at the month boundary, as it drops any other', () => {
    const past = quotaRows(
      snapshotOf({ anthropic: { meters: [monthly(2119.26)] } }),
      MONTH_END + MINUTE
    )

    // Correct rather than a bug: the next fetch computes the new month.
    expect(past[0]).toMatchObject({ state: 'unknown', right: '', meters: [] })
  })

  it('dims a stale monthly meter and shows the reading\u2019s age instead', () => {
    const rows = quotaRows(
      snapshotOf({
        anthropic: { fetchedAt: NOW - 12 * MINUTE, meters: [monthly(4700)] }
      }),
      NOW
    )

    expect(rows[0].state).toBe('stale')
    expect(rows[0].right).toBe('·12m')
    // The alarm goes with the emphasis, so no `!` on a distrusted reading.
    expect(rows[0].meters[0].text).toBe('$4.7k/$5k · 94%')
    expect(rows[0].meters[0].level).toBe('normal')
    expect(rows[0].meters[0].tickPercent).toBeDefined()
  })

  it('drops a monthly reading past an hour old to a dash', () => {
    const rows = quotaRows(
      snapshotOf({ anthropic: { fetchedAt: NOW - 61 * MINUTE, meters: [monthly(2119.26)] } }),
      NOW
    )

    expect(rows[0]).toMatchObject({ state: 'unknown', meters: [] })
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

  it('shows a scoped meter at zero like any other, per Q1', () => {
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

    // Every meter for every provider, visible at all times. An unused plan
    // feature reads as an honest 0%, never as an absent row.
    expect(rows[0].meters.map((shown) => shown.label)).toEqual(['7D', 'FABLE', 'SPARK'])
    expect(rows[0].meters.map((shown) => shown.text)).toEqual(['29%', '0%', '0%'])
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
