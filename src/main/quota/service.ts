import type {
  QuotaListener,
  QuotaRefreshOptions,
  QuotaService,
  Unsubscribe
} from '../../shared/quota/service'
import type { QuotaSnapshot } from '../../shared/quota/types'
import type { QuotaStore } from './store'

// The single real implementation, hosted in main over one store. Whatever is
// on screen — one window or three, a dozen sessions — there is one fetcher and
// one cache, which is what keeps the request count a property of the machine
// rather than of how many things are looking.

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
      // throw must still not become a rejected IPC call: fetch trouble reaches
      // the user as staleness in the data and never as an error.
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
