import type {
  CacheHealth,
  CacheHealthListener,
  CacheService,
  Unsubscribe
} from '../../../shared/cache/service'
import { cacheBridge } from '../bridge'

// Holds no state: the file, the serialization and the arithmetic are main's,
// and this document only asks and listens.

export function createCacheClient(): CacheService {
  const cache = cacheBridge()
  const listeners = new Set<CacheHealthListener>()

  cache.onEvent((health) => {
    for (const listener of [...listeners]) listener(health)
  })

  async function call(op: string): Promise<CacheHealth> {
    const result = await cache.request({ op, args: [] })
    if (!result.ok) throw new Error(result.message)
    return result.value as CacheHealth
  }

  return {
    read: () => call('read'),
    reset: () => call('reset'),

    onChange(listener: CacheHealthListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
