import type { CacheHealth, CacheHealthListener, CacheService, Unsubscribe } from './service'

// The cache service without a filesystem: the strip, the dialog and the badge
// are renderer surfaces, and a test drives them by saying what the ledger
// holds rather than by writing one. Answers the way main does and announces
// nothing by itself.

export interface FakeCacheService extends CacheService {
  /** What the next read answers with; may be changed between calls. */
  health: CacheHealth
  /** The refusal a rejected IPC call is. */
  refusal?: string
  // Holding a reset is how a test sees what the dialog paints while one is
  // still running.
  holdReset?: boolean
  releaseReset(): void
  /** A miss landing anywhere, exactly as main announces one. */
  recordMiss(dollars: number): void
  /** Announces a health of the test's own making. */
  announce(health: CacheHealth): void
}

export const FAKE_LEDGER_PATH =
  '/Users/you/Library/Application Support/Crucible/cache-misses.jsonl'

export function fakeCacheHealth(over: Partial<CacheHealth> = {}): CacheHealth {
  return {
    count: 0,
    dollars: 0,
    since: '2026-08-19T15:04:00.000Z',
    ledgerPath: FAKE_LEDGER_PATH,
    retention: '5m',
    ...over
  }
}

export function createFakeCacheService(
  initial: CacheHealth = fakeCacheHealth(),
  clock: () => string = () => new Date().toISOString()
): FakeCacheService {
  const listeners = new Set<CacheHealthListener>()
  let held: Array<() => void> = []

  function announce(health: CacheHealth): void {
    service.health = health
    for (const listener of [...listeners]) listener(health)
  }

  function resetNow(): CacheHealth {
    // A reset deletes nothing here either: it re-dates the counter and the
    // count starts again from that instant.
    return { ...service.health, count: 0, dollars: 0, since: clock() }
  }

  const service: FakeCacheService = {
    health: initial,

    read(): Promise<CacheHealth> {
      if (service.refusal !== undefined) return Promise.reject(new Error(service.refusal))
      return Promise.resolve(service.health)
    },

    reset(): Promise<CacheHealth> {
      if (service.refusal !== undefined) return Promise.reject(new Error(service.refusal))
      if (service.holdReset !== true) {
        const health = resetNow()
        announce(health)
        return Promise.resolve(health)
      }
      return new Promise<CacheHealth>((resolve) => {
        held.push(() => {
          const health = resetNow()
          announce(health)
          resolve(health)
        })
      })
    },

    onChange(listener: CacheHealthListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    releaseReset(): void {
      const waiting = held
      held = []
      for (const answer of waiting) answer()
    },

    recordMiss(dollars: number): void {
      announce({
        ...service.health,
        count: service.health.count + 1,
        dollars: Math.round((service.health.dollars + dollars) * 100) / 100
      })
    },

    announce
  }

  return service
}
