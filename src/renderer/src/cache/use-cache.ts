import { useEffect, useState } from 'react'
import type { CacheHealth, CacheService } from '../../../shared/cache/service'

// The counter as main holds it. Read once at mount and repainted on every
// change, so a miss landing anywhere — any session, any run — moves the strip
// while you watch.

/** Undefined until the first read answers, and forever without a service. */
export function useCacheHealth(service?: CacheService): CacheHealth | undefined {
  const [health, setHealth] = useState<CacheHealth | undefined>(undefined)

  useEffect(() => {
    if (service === undefined) return
    let alive = true
    const stop = service.onChange((taken) => {
      if (alive) setHealth(taken)
    })
    void service
      .read()
      .then((taken) => {
        if (alive) setHealth(taken)
      })
      // A read that failed leaves the strip absent rather than showing a
      // number nobody counted.
      .catch(() => {})
    return () => {
      alive = false
      stop()
    }
  }, [service])

  return health
}
