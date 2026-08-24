import { isLive, isStale, MAX_USABLE_AGE_MS } from '../../../shared/quota/freshness'
import { monthWindowStart } from '../../../shared/quota/month'
import type { QuotaMeter, QuotaSnapshot } from '../../../shared/quota/types'

// Everything the strip draws is decided here, in pure functions, so the
// thresholds and the pace arithmetic can be tested without a document.

/** Both weekly kinds run seven days; the pace tick means nothing without that. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

// Pace stays quiet through the first day of a window: a tiny elapsed fraction
// as a divisor swings wildly, and a projection believable but too early to be
// true is worse than none.
const FIRST_DAY_MS = DAY_MS

// Within a week the weekday names the day unambiguously; further out it does
// not, and a monthly meter can project weeks away.
const NEAR_MS = 7 * DAY_MS

// Display order within a row: 5H, 7D, a scoped meter, then the monthly one.
// Longest window last.
const KIND_RANK: Record<QuotaMeter['kind'], number> = {
  session: 0,
  weekly: 1,
  weekly_scoped: 2,
  monthly: 3
}

// An id with no entry displays as itself, so a provider gaining an adapter
// needs no change here to appear.
const NAMES: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  'openai-codex': 'Codex',
  xai: 'Grok'
}

export function providerName(providerId: string): string {
  return NAMES[providerId] ?? providerId
}

export type MeterLevel = 'normal' | 'warn' | 'crit'

export type RowState = 'ok' | 'stale' | 'unknown'

export interface MeterView {
  readonly key: string
  readonly label: string
  readonly kind: QuotaMeter['kind']
  /** The exact percent, not the rounded one the text prints. */
  readonly fillPercent: number
  readonly text: string
  readonly level: MeterLevel
  /** Absent means no tick on this bar. */
  readonly tickPercent?: number
}

export interface RowView {
  readonly providerId: string
  readonly name: string
  readonly state: RowState
  readonly right: string
  /** Present only when the projection lands past 100% before the reset. */
  readonly outWord?: string
  readonly meters: readonly MeterView[]
}

// A meter at or past its reset prints nothing: it is about to be dropped as
// lapsed, and "now" is not a countdown.
export function countdownText(resetsAt: number, now: number): string {
  const ms = resetsAt - now
  if (ms <= 0) return ''
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `⟳<${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `⟳${hours}h${String(minutes % 60).padStart(2, '0')}`
  return `⟳${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, '0')}`
}

// Under a minute prints `·<1m` rather than a rounded-down `·0m`, which would
// claim a freshness the reading does not have.
export function ageText(age: number): string {
  return age >= 60_000 ? `·${Math.floor(age / 60_000)}m` : '·<1m'
}

// Color comes from the absolute percent alone; pace never recolors anything.
export function levelOf(usedPercent: number): MeterLevel {
  if (usedPercent >= 90) return 'crit'
  if (usedPercent >= 70) return 'warn'
  return 'normal'
}

// Pace applies to the windowed meters only: hitting the session one is rare
// enough not to watch.
function paced(meter: QuotaMeter): boolean {
  return meter.kind === 'weekly' || meter.kind === 'weekly_scoped' || meter.kind === 'monthly'
}

/**
 * How long the window this meter's reset closes runs. A month is 28 to 31 days
 * as the calendar falls, so it is measured rather than assumed.
 */
function windowMs(meter: QuotaMeter, resetsAt: number): number {
  return meter.kind === 'monthly' ? resetsAt - monthWindowStart(resetsAt) : WEEK_MS
}

/** `null` when pace has nothing to say about this meter yet. */
export function paceFraction(meter: QuotaMeter, now: number): number | null {
  if (!paced(meter) || meter.resetsAt === null) return null
  const length = windowMs(meter, meter.resetsAt)
  const elapsed = now - (meter.resetsAt - length)
  if (elapsed < FIRST_DAY_MS) return null
  return Math.min(1, Math.max(0, elapsed / length))
}

// A straight line through the current spending, with no history and no stored
// series: the same rough estimate a reader would make in their head.
export function crossingAt(meter: QuotaMeter, now: number): number | null {
  const fraction = paceFraction(meter, now)
  if (fraction === null || fraction === 0) return null
  if (meter.usedPercent <= 0) return null
  if (meter.usedPercent / fraction <= 100) return null
  const resetsAt = meter.resetsAt as number
  const length = windowMs(meter, resetsAt)
  return resetsAt - length + fraction * length * (100 / meter.usedPercent)
}

// A provider on track says nothing at all, which is what makes the word a
// signal when it does appear.
export function outWord(meters: readonly QuotaMeter[], now: number): string | undefined {
  let earliest: number | undefined
  for (const meter of meters) {
    const crossing = crossingAt(meter, now)
    if (crossing === null) continue
    if (earliest === undefined || crossing < earliest) earliest = crossing
  }
  if (earliest === undefined) return undefined
  return `out ${crossingDay(earliest, now)}`
}

/** A weekday inside the week, a month and day beyond it. */
export function crossingDay(crossing: number, now: number): string {
  const shape: Intl.DateTimeFormatOptions =
    crossing - now < NEAR_MS ? { weekday: 'short' } : { month: 'short', day: 'numeric' }
  return new Date(crossing).toLocaleDateString(undefined, shape)
}

/**
 * The working precedent's dollar shape (`~/.claude/usage-filter.jq`): thousands
 * above $1000, whole dollars above $100 or where the amount is whole, and cents
 * below that.
 */
export function dollarText(amount: number): string {
  if (amount >= 1000) {
    const thousands = Math.round((amount / 1000) * 10) / 10
    return `$${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`
  }
  if (amount >= 100 || Number.isInteger(amount)) return `$${Math.round(amount)}`
  return `$${Math.round(amount * 100) / 100}`
}

// Dollars where the plan meters dollars, a percent where it meters a percent.
// The printed percent is unclamped, so an overage says 104% while the fill pins
// at 100 — the bar cannot draw past its end, but the number must not lie.
function meterText(meter: QuotaMeter, level: MeterLevel): string {
  const alarm = level === 'crit' ? '!' : ''
  const used = meter.usedDollars
  const limit = meter.limitDollars
  if (meter.kind === 'monthly' && used !== undefined && limit !== undefined && limit > 0) {
    return `${alarm}${dollarText(used)}/${dollarText(limit)} · ${Math.round((used / limit) * 100)}%`
  }
  return `${alarm}${Math.round(meter.usedPercent)}%`
}

function meterView(meter: QuotaMeter, index: number, now: number, stale: boolean): MeterView {
  // A stale row drops the emphasis: a number the app has stopped trusting does
  // not shout.
  const level = stale ? 'normal' : levelOf(meter.usedPercent)
  const tick = paceFraction(meter, now)
  return {
    key: `${meter.kind}\u0000${meter.label}\u0000${index}`,
    label: meter.label,
    kind: meter.kind,
    fillPercent: Math.min(100, Math.max(0, meter.usedPercent)),
    text: meterText(meter, level),
    level,
    // The tick is a clock fact, so a stale row keeps it; only the projection,
    // which needs a number the strip trusts, goes quiet.
    ...(tick === null ? {} : { tickPercent: tick * 100 })
  }
}

// Sorted by display name so rows never reshuffle under the cursor as readings
// arrive. A provider with no credential is not in the snapshot at all, which
// is what signed out looks like: no row, no placeholder, no explanation.
export function quotaRows(snapshot: QuotaSnapshot | undefined, now: number): readonly RowView[] {
  if (snapshot === undefined) return []
  return Object.values(snapshot.providers)
    .map((quota) => {
      const name = providerName(quota.providerId)
      const age = now - quota.fetchedAt
      // Dropped here too: the held snapshot ages between reads, and a
      // rolled-over percent is wrong rather than merely old.
      const live = quota.meters.filter((meter) => isLive(meter, now))
      // Every meter the plan reports, at every percent including zero: Q1
      // asks for all of them visible at all times, and a row that comes and
      // goes as a number crosses zero is harder to read than an empty bar.
      const shown = [...live].sort(
        (left, right) => KIND_RANK[left.kind] - KIND_RANK[right.kind]
      )

      if (shown.length === 0 || age > MAX_USABLE_AGE_MS) {
        // Never a lapsed number and never a zero: the name over a single dash.
        return { providerId: quota.providerId, name, state: 'unknown' as const, right: '', meters: [] }
      }

      const stale = isStale(quota, now)
      // The spend meter contributes no countdown (Q2): a reader knows when the
      // month ends, so counting down to it says nothing. Its reset instant
      // still drives the pace tick, the projection and lapse detection; what
      // Q2 removed is a countdown, not a clock fact. A row with no other meter,
      // which is the work account's case, ends up with the empty right-hand
      // side an all-null-reset row already produces.
      const resets = live
        .filter((meter) => meter.kind !== 'monthly')
        .map((meter) => meter.resetsAt)
        .filter((resetsAt): resetsAt is number => resetsAt !== null)
      const longest = resets.length === 0 ? undefined : Math.max(...resets)
      const word = stale ? undefined : outWord(shown, now)

      return {
        providerId: quota.providerId,
        name,
        state: stale ? ('stale' as const) : ('ok' as const),
        // A dimmed reading never leaves the reader guessing how old it is, so
        // the age takes the countdown's place.
        right: stale ? ageText(age) : longest === undefined ? '' : countdownText(longest, now),
        ...(word === undefined ? {} : { outWord: word }),
        meters: shown.map((meter, index) => meterView(meter, index, now, stale))
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.providerId.localeCompare(right.providerId))
}
