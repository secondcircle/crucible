import type { CacheRetention } from '../agent/port'

// How long the provider keeps a cached prefix, mirrored from π. Shared rather
// than kept beside the rest of π's mirrored arithmetic in main, because the
// cache expiry choice decides whether a prefix is still alive in the renderer,
// in the frame the send lands: one number, read on both sides of the port, so
// the trigger and the mirror cannot drift.

/** π's `CACHE_TTL_MS`: Anthropic's default prompt-cache lifetime. */
export const CACHE_TTL_MS = 5 * 60 * 1000

/** What `PI_CACHE_RETENTION=long` buys: the hour Crucible asks for. */
export const LONG_CACHE_TTL_MS = 60 * 60 * 1000

/** How long the provider keeps a cached prefix under each retention. */
export function cacheTtlMs(retention: CacheRetention): number {
  return retention === '1h' ? LONG_CACHE_TTL_MS : CACHE_TTL_MS
}
