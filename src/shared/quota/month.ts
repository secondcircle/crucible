// The monthly meter's window, computed in exactly one place. The usage payload
// carries no reset instant for `.spend`, so Crucible draws the calendar month
// itself: resetting the 1st, in UTC, because every `resets_at` the same payload
// does carry is UTC. If a drawn window ever visibly disagrees with the
// provider's real cycle, this is the one function a reset-day setting replaces.

/** The first instant of the calendar month after `now`, UTC. */
export function monthlyResetAfter(now: number): number {
  const at = new Date(now)
  // A December date asks for month 12, which `Date.UTC` reads as January next
  // year — the rollover needs no arithmetic of its own.
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)
}

/**
 * One calendar month before a reset instant, UTC: the start of the window that
 * reset closes, 28 to 31 days long as the month dictates.
 */
export function monthWindowStart(resetsAt: number): number {
  const at = new Date(resetsAt)
  return Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth() - 1,
    at.getUTCDate(),
    at.getUTCHours(),
    at.getUTCMinutes(),
    at.getUTCSeconds(),
    at.getUTCMilliseconds()
  )
}
