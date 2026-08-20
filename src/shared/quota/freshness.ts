import type { ProviderQuota, QuotaMeter, QuotaSnapshot } from './types'

// The two freshness boundaries and the one definition of "stale", written down
// once. The reader, the store and the quota strip all import this module, so
// none of them can drift from the others about how old a reading may be.

/**
 * Old enough that the row dims and shows its age, and old enough that the read
 * seam stops answering with it.
 *
 * Deliberately longer than the store's 60 s TTL: a reading one TTL old is the
 * freshest the cache is allowed to be, and dimming a healthy idle row every
 * minute would turn the strip into an alarm surface. Five minutes is the first
 * age worth reading at the strip's one-minute granularity.
 */
export const STALE_AFTER_MS = 5 * 60 * 1000

/**
 * Past an hour a reading is not merely stale but no longer evidence: an hour of
 * unseen spending can move a meter far enough that the number stops describing
 * now. The row drops to `—` rather than dimming.
 */
export const MAX_USABLE_AGE_MS = 60 * 60 * 1000

/** A meter whose reset instant has not passed. Lapsed ones are never shown. */
export function isLive(meter: QuotaMeter, now: number): boolean {
  return meter.resetsAt === null || meter.resetsAt > now
}

/**
 * Is this reading still describing now?
 *
 * Two ways to fail, and the strip draws both the same way — dimmed, with an
 * age: a failed attempt over the reading, or simply having aged past
 * `STALE_AFTER_MS`. This is the single definition of "stale" for the whole
 * feature: `worstUsedPercent` refuses to answer with a stale reading and the
 * strip's own state machine asks this exact question.
 */
export function isStale(quota: ProviderQuota, now: number = Date.now()): boolean {
  return quota.error !== undefined || now - quota.fetchedAt >= STALE_AFTER_MS
}

/**
 * The highest used percent among that provider's live meters — used, like
 * everything else, so no consumer ever computes `100 − x`.
 *
 * `null` means unknown: no adapter, no credential, nothing cached, every meter
 * lapsed, or a reading gone stale. Unknown is never 0 and never 100, because a
 * consumer that reads a fabricated number cannot tell it from a real one.
 */
export function worstUsedPercent(
  snapshot: QuotaSnapshot,
  providerId: string,
  now: number = Date.now()
): number | null {
  const quota = snapshot.providers[providerId]
  if (quota === undefined) return null
  if (isStale(quota, now)) return null
  const live = quota.meters.filter((meter) => isLive(meter, now))
  if (live.length === 0) return null
  return live.reduce((worst, meter) => Math.max(worst, meter.usedPercent), 0)
}
