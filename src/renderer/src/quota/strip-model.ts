import { isLive, isStale, MAX_USABLE_AGE_MS } from '../../../shared/quota/freshness'
import type { QuotaMeter, QuotaSnapshot } from '../../../shared/quota/types'

// Snapshot plus a clock in, the quota strip's rows out. Everything the strip
// draws is decided here, in one pure function, so the countdown format, the
// thresholds and the pace arithmetic can be read and tested without a document.

/** Both weekly kinds run seven days; the pace tick means nothing without that. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Pace says nothing in roughly the first day of a window. A tiny elapsed
 * fraction as a divisor swings wildly, and a projection precise enough to be
 * believed and too early to be true is worse than no projection. The measured
 * percent still shows.
 */
const FIRST_DAY_MS = 24 * 60 * 60 * 1000

/** Display order within a row, and the mock's: 5H, then 7D, then FABLE. */
const KIND_RANK: Record<QuotaMeter['kind'], number> = {
  session: 0,
  weekly: 1,
  weekly_scoped: 2
}

/**
 * The names Crucible shows for the providers it knows. An id it does not know
 * displays as itself and sorts in the same ordering, so a provider gaining an
 * adapter needs no change here to appear.
 */
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
  /** The exact used percent, clamped to the bar: the fill's width. */
  readonly fillPercent: number
  /** What the number says: `73%`, or `!91%` once red. */
  readonly text: string
  readonly level: MeterLevel
  /** Where the pace tick sits, 0–100. Absent means no tick on this bar. */
  readonly tickPercent?: number
}

export interface RowView {
  readonly providerId: string
  readonly name: string
  readonly state: RowState
  /** The right of the provider line: a countdown, a stale row's age, or nothing. */
  readonly right: string
  /** `out Sat` — present only when the projection lands past 100% in time. */
  readonly outWord?: string
  readonly meters: readonly MeterView[]
}

/**
 * The shipped renderer's countdown, verbatim: `⟳<9m`, `⟳3h07`, `⟳4d11`. A meter
 * at or past its reset prints nothing, because it is about to be dropped as
 * lapsed and "now" is not a countdown.
 */
export function countdownText(resetsAt: number, now: number): string {
  const ms = resetsAt - now
  if (ms <= 0) return ''
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `⟳<${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `⟳${hours}h${String(minutes % 60).padStart(2, '0')}`
  return `⟳${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, '0')}`
}

/**
 * How old a dimmed reading is. Under a minute the truthful age is `·<1m` — the
 * countdown's own convention — rather than a rounded-down `·0m`, which would be
 * a lie. Ages never exceed `·59m`, because past an hour the row is unknown.
 */
export function ageText(age: number): string {
  return age >= 60_000 ? `·${Math.floor(age / 60_000)}m` : '·<1m'
}

/** Color comes from the absolute percent alone; pace never recolors anything. */
export function levelOf(usedPercent: number): MeterLevel {
  if (usedPercent >= 90) return 'crit'
  if (usedPercent >= 70) return 'warn'
  return 'normal'
}

/** Pace applies to weekly meters only. The 5H meter never gets a tick. */
function paced(meter: QuotaMeter): boolean {
  return meter.kind === 'weekly' || meter.kind === 'weekly_scoped'
}

/**
 * How much of this meter's week has elapsed, 0–1, or `null` when pace has
 * nothing to say: a session meter, a meter with no reset instant, or a window
 * still inside its first day.
 */
export function paceFraction(meter: QuotaMeter, now: number): number | null {
  if (!paced(meter) || meter.resetsAt === null) return null
  const elapsed = now - (meter.resetsAt - WEEK_MS)
  if (elapsed < FIRST_DAY_MS) return null
  return Math.min(1, Math.max(0, elapsed / WEEK_MS))
}

/**
 * The instant a straight line through the current spending crosses 100%, or
 * `null` when it does not cross before the reset. No history, no sampling, no
 * stored series: the same rough estimate you would do in your head.
 */
export function crossingAt(meter: QuotaMeter, now: number): number | null {
  const fraction = paceFraction(meter, now)
  if (fraction === null || fraction === 0) return null
  if (meter.usedPercent <= 0) return null
  if (meter.usedPercent / fraction <= 100) return null
  const windowStart = (meter.resetsAt as number) - WEEK_MS
  return windowStart + fraction * WEEK_MS * (100 / meter.usedPercent)
}

/**
 * One word for the whole provider, and only when it is earned: the weekday the
 * earliest projecting meter runs out. Providers on track say nothing, so the
 * word appearing is the signal.
 */
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

/**
 * A scoped meter at exactly 0% that the provider does not call binding is a
 * plan feature this account has never used: a permanent empty bar the reader
 * learns to skip. It appears the moment it shows use or the provider flags it
 * active. Every other meter the payload reports is shown, always.
 */
function noise(meter: QuotaMeter): boolean {
  return meter.kind === 'weekly_scoped' && meter.usedPercent === 0 && meter.isActive !== true
}

function meterView(meter: QuotaMeter, index: number, now: number, stale: boolean): MeterView {
  // Thresholds read the exact percent and the printed digits are rounded, so
  // 89.6 prints "90%" and is still amber. A stale row drops the emphasis
  // altogether: a number the app has stopped trusting does not shout.
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
    // which needs a trusted number, goes quiet.
    ...(tick === null ? {} : { tickPercent: tick * 100 })
  }
}

/**
 * Every provider in the snapshot, alphabetically by display name and therefore
 * in a fixed order: rows never reshuffle under the cursor as readings arrive.
 * A provider with no credential is not in the snapshot at all, and that is what
 * signed out looks like — no row, no placeholder, no explanation.
 */
export function quotaRows(snapshot: QuotaSnapshot | undefined, now: number): readonly RowView[] {
  if (snapshot === undefined) return []
  return Object.values(snapshot.providers)
    .map((quota) => {
      const name = providerName(quota.providerId)
      const age = now - quota.fetchedAt
      // Lapsed meters are dropped here too: the held snapshot ages between
      // reads, and a rolled-over percent is wrong rather than merely old.
      const live = quota.meters.filter((meter) => isLive(meter, now))
      const shown = [...live.filter((meter) => !noise(meter))].sort(
        (left, right) => KIND_RANK[left.kind] - KIND_RANK[right.kind]
      )

      if (shown.length === 0 || age > MAX_USABLE_AGE_MS) {
        // Never a stale number and never a zero: the name over a single dash.
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
        // Dim and aged: a reading the strip has dimmed never leaves the reader
        // guessing how old it is, so the age takes the countdown's place.
        right: stale ? ageText(age) : longest === undefined ? '' : countdownText(longest, now),
        ...(word === undefined ? {} : { outWord: word }),
        meters: shown.map((meter, index) => meterView(meter, index, now, stale))
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.providerId.localeCompare(right.providerId))
}
