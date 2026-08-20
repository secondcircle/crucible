import type {
  QuotaListener,
  QuotaRefreshOptions,
  QuotaService,
  Unsubscribe
} from '../../shared/quota/service'
import type { QuotaSnapshot } from '../../shared/quota/types'
import type { QuotaStore } from './store'

// One store for the launch, so the request count is a property of the machine
// rather than of how many windows and sessions are looking.

export function createQuotaService(store: QuotaStore): QuotaService {
  const listeners = new Set<QuotaListener>()

  function announce(snapshot: QuotaSnapshot): QuotaSnapshot {
    for (const listener of [...listeners]) listener(snapshot)
    return snapshot
  }

  return {
    read: () => Promise.resolve(store.read()),

    async refresh(opts: QuotaRefreshOptions = {}): Promise<QuotaSnapshot> {
      // The store never throws for a fetch failure, and a bug that made it
      // throw must still not reach the user as an error rather than staleness.
      try {
        return announce(await store.refresh(opts))
      } catch {
        return announce(store.read())
      }
    },

    onChange(listener: QuotaListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
