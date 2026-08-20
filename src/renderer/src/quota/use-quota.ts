import { useCallback, useEffect, useRef, useState } from 'react'
import type { QuotaService } from '../../../shared/quota/service'
import type { QuotaSnapshot } from '../../../shared/quota/types'

// The strip owns the triggers; the store owns the rate limit. Every trigger
// here is a `refresh()` the 60 s TTL and main's per-provider in-flight dedupe
// may turn into a no-op, which is what makes duplicate triggers — two windows,
// two events in one second — free. Nothing in this module fetches on its own,
// and the display timer below never performs IO.

/** Two reset instants this close are one reset: Anthropic's weekly pair differs by microseconds. */
export const SAME_RESET_MS = 1000

/**
 * How often the strip re-derives its display from data already in hand, so
 * countdowns tick down, ages tick up and rows cross the stale and unknown
 * boundaries on time. It repaints; the only network consequence it can have is
 * a reset instant passing, which asks once for that provider alone.
 */
export const DISPLAY_TICK_MS = 60_000

export interface QuotaView {
  /** Undefined until the first read answers, and forever without a service. */
  readonly snapshot: QuotaSnapshot | undefined
  /** The instant the rows are drawn against. */
  readonly now: number
}

export interface QuotaHold extends QuotaView {
  /** Ask for a refresh. Unscoped unless a provider is named. */
  readonly refresh: (providers?: readonly string[]) => void
}

/**
 * The strip's whole relationship with the quota service: the cached paint on
 * launch, the four refresh triggers, and a minute timer that only repaints.
 *
 * Without a service there is no strip: nothing is read, nothing is asked, and
 * the snapshot stays undefined.
 */
export function useQuota(service?: QuotaService): QuotaHold {
  const [snapshot, setSnapshot] = useState<QuotaSnapshot | undefined>(undefined)
  const [now, setNow] = useState<number>(() => Date.now())
  /** Reset instants already asked about, so one reset asks once for the run. */
  const asked = useRef<Array<{ readonly providerId: string; readonly at: number }>>([])

  const apply = useCallback((taken: QuotaSnapshot): void => {
    setSnapshot(taken)
    // A fresh reading is drawn against a fresh clock, so an age is never
    // measured from a minute-old instant.
    setNow(Date.now())
  }, [])

  const refresh = useCallback(
    (providers?: readonly string[]): void => {
      if (service === undefined) return
      void service
        .refresh(providers === undefined ? {} : { providers })
        .then(apply)
        // A refused call leaves the strip exactly as it was: fetch trouble
        // reaches the user as staleness in the data, never as a UI error.
        .catch(() => {})
    },
    [service, apply]
  )

  // Launch: the last cached reading paints immediately, dimmed with its age if
  // that is what it is, instead of an empty block or a spinner. The refresh
  // that follows repaints through the ordinary change event.
  useEffect(() => {
    if (service === undefined) return
    let alive = true
    const stop = service.onChange((taken) => {
      if (alive) apply(taken)
    })
    void service
      .read()
      .then((cached) => {
        if (alive) apply(cached)
      })
      .catch(() => {})
    refresh()
    return () => {
      alive = false
      stop()
    }
  }, [service, refresh, apply])

  // Window focus: the app was away, and whatever was spent elsewhere shows on
  // the way back.
  useEffect(() => {
    if (service === undefined) return
    const onFocus = (): void => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [service, refresh])

  // The display timer. It repaints from data in hand and performs no IO.
  useEffect(() => {
    if (service === undefined) return
    const tick = setInterval(() => setNow(Date.now()), DISPLAY_TICK_MS)
    return () => clearInterval(tick)
  }, [service])

  // A countdown reaching zero is the one moment an idle number is certainly
  // wrong, so ask for one refresh of THAT provider — once per reset instant,
  // never a poll, and never on anyone else's behalf. Detection works from the
  // snapshot in hand precisely because a fresh read would have dropped the
  // lapsed meter.
  useEffect(() => {
    if (service === undefined || snapshot === undefined) return
    for (const quota of Object.values(snapshot.providers)) {
      let ask = false
      for (const meter of quota.meters) {
        const resetsAt = meter.resetsAt
        if (resetsAt === null || resetsAt > now) continue
        const known = asked.current.some(
          (earlier) =>
            earlier.providerId === quota.providerId &&
            Math.abs(earlier.at - resetsAt) <= SAME_RESET_MS
        )
        if (known) continue
        asked.current.push({ providerId: quota.providerId, at: resetsAt })
        ask = true
      }
      if (ask) refresh([quota.providerId])
    }
  }, [service, snapshot, now, refresh])

  return { snapshot, now, refresh }
}
