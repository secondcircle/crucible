import { isLive, isStale, MAX_USABLE_AGE_MS } from '../../../shared/quota/freshness'
import type { QuotaMeter, QuotaSnapshot } from '../../../shared/quota/types'

// Everything the strip draws is decided here, in pure functions, so the
// thresholds and the pace arithmetic can be tested without a document.

/** Both weekly kinds run seven days; the pace tick means nothing without that. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

// Pace stays quiet through the first day of a window: a tiny elapsed fraction
// as a divisor swings wildly, and a projection believable but too early to be
// true is worse than none.
const FIRST_DAY_MS = 24 * 60 * 60 * 1000

// Display order within a row: 5H, then 7D, then a scoped meter.
const KIND_RANK: Record<QuotaMeter['kind'], number> = {
  session: 0,
  weekly: 1,
  weekly_scoped: 2
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

// Pace applies to weekly meters only: hitting the session one is rare enough
// not to watch.
function paced(meter: QuotaMeter): boolean {
  return meter.kind === 'weekly' || meter.kind === 'weekly_scoped'
}

/** `null` when pace has nothing to say about this meter yet. */
export function paceFraction(meter: QuotaMeter, now: number): number | null {
  if (!paced(meter) || meter.resetsAt === null) return null
  const elapsed = now - (meter.resetsAt - WEEK_MS)
  if (elapsed < FIRST_DAY_MS) return null
  return Math.min(1, Math.max(0, elapsed / WEEK_MS))
}

// A straight line through the current spending, with no history and no stored
// series: the same rough estimate a reader would make in their head.
export function crossingAt(meter: QuotaMeter, now: number): number | null {
  const fraction = paceFraction(meter, now)
  if (fraction === null || fraction === 0) return null
  if (meter.usedPercent <= 0) return null
  if (meter.usedPercent / fraction <= 100) return null
  const windowStart = (meter.resetsAt as number) - WEEK_MS
  return windowStart + fraction * WEEK_MS * (100 / meter.usedPercent)
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
  return `out ${new Date(earliest).toLocaleDateString(undefined, { weekday: 'short' })}`
}

// A scoped meter at exactly 0% and not called binding is a plan feature the
// account has never used: a permanent empty bar the reader learns to skip.
function noise(meter: QuotaMeter): boolean {
  return meter.kind === 'weekly_scoped' && meter.usedPercent === 0 && meter.isActive !== true
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
    text: `${level === 'crit' ? '!' : ''}${Math.round(meter.usedPercent)}%`,
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
      const shown = [...live.filter((meter) => !noise(meter))].sort(
        (left, right) => KIND_RANK[left.kind] - KIND_RANK[right.kind]
      )

      if (shown.length === 0 || age > MAX_USABLE_AGE_MS) {
        // Never a lapsed number and never a zero: the name over a single dash.
        return { providerId: quota.providerId, name, state: 'unknown' as const, right: '', meters: [] }
      }

      const stale = isStale(quota, now)
      const resets = live
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
