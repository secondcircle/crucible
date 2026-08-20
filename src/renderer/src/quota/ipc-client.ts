import type {
  QuotaListener,
  QuotaRefreshOptions,
  QuotaService,
  Unsubscribe
} from '../../../shared/quota/service'
import type { QuotaSnapshot } from '../../../shared/quota/types'
import { quotaBridge } from '../bridge'

// Holds no state: the cache, the locks and the TTL are main's, and this
// document only asks and listens.

export function createQuotaClient(): QuotaService {
  const quota = quotaBridge()
  const listeners = new Set<QuotaListener>()

  quota.onEvent((snapshot) => {
    for (const listener of [...listeners]) listener(snapshot)
  })

  async function call(op: string, ...args: readonly unknown[]): Promise<QuotaSnapshot> {
    const result = await quota.request({ op, args })
    if (!result.ok) throw new Error(result.message)
    return result.value as QuotaSnapshot
  }

  return {
    read: () => call('read'),
    refresh: (opts: QuotaRefreshOptions = {}) => call('refresh', opts),

    onChange(listener: QuotaListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
