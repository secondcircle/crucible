import type { CachedPrefix } from '../../../shared/agent/port'
import { cacheTtlMs } from '../../../shared/cache/ttl'

// The one question the cache expiry choice's trigger asks, answered in the
// frame of the send gesture. Certainty is the whole point: the provider drops
// a prefix once it is older than the retention it was written under, so past
// that line the re-bill is not a risk but a fact.

export function prefixExpired(prefix: CachedPrefix, now: number): boolean {
  const at = Date.parse(prefix.at)
  // A stamp nothing can read is not evidence of anything, and a dialog raised
  // on it would be a guess.
  if (Number.isNaN(at)) return false
  return now - at > cacheTtlMs(prefix.retention)
}

/** How long the conversation has been sitting, which is what the dialog says. */
export function idleMs(prefix: CachedPrefix, now: number): number {
  const at = Date.parse(prefix.at)
  return Number.isNaN(at) ? 0 : Math.max(0, now - at)
}
