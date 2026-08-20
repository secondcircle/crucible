import type { ProviderQuota, QuotaMeter, QuotaSnapshot } from './types'

// One definition of "stale" for the reader, the store and the strip, so none
// of them can drift from the others about how old a reading may be.

// Longer than the store's 60 s TTL on purpose: a reading one TTL old is the
// freshest the cache may be, so dimming at the TTL would dim healthy rows.

export const STALE_AFTER_MS = 5 * 60 * 1000

// An hour of unseen spending can move a meter far enough that the number stops
// describing now, so the row drops to `—` rather than dimming.

export const MAX_USABLE_AGE_MS = 60 * 60 * 1000

export function isLive(meter: QuotaMeter, now: number): boolean {
  return meter.resetsAt === null || meter.resetsAt > now
}

/** A failed attempt and mere age are the same staleness to every consumer. */
export function isStale(quota: ProviderQuota, now: number = Date.now()): boolean {
  return quota.error !== undefined || now - quota.fetchedAt >= STALE_AFTER_MS
}

/**
 * `null` is unknown, never 0 and never 100: a consumer that reads a fabricated
 * number cannot tell it from a real one.
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
