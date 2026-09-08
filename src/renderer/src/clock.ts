import { useEffect, useState } from 'react'

// The clock the relative times in this app are read against, so they age on
// their own rather than only when something else re-renders. One clock for
// both kinds: a running counter needs a second, a "4m ago" does not, and
// paying for the fast one only while something is live keeps an idle window
// still.

/** Relative times go stale on their own; nothing may fossilize on "just now". */
export const TICK_MS = 30_000

/** A counter that only moved every 30s would look stopped. */
export const WORKING_TICK_MS = 1_000

export function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const every = active ? WORKING_TICK_MS : TICK_MS
    const tick = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(tick)
  }, [active])
  return now
}
