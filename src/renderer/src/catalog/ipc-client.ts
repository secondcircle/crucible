import type { Unsubscribe } from '../../../shared/agent/port'
import type {
  CatalogListener,
  CatalogSnapshot,
  WorkflowCatalogService
} from '../../../shared/workflows/catalog'
import type { CatalogReaderSettings } from '../../../shared/workflows/catalog-settings'
import { catalogBridge } from '../bridge'

// The renderer's side of the catalog channel. It holds no state: the
// catalog's answer is the truth and every event carries a whole snapshot.

export function createCatalogClient(): WorkflowCatalogService {
  const bridge = catalogBridge()
  const listeners = new Set<CatalogListener>()

  bridge.onEvent((event) => {
    for (const listener of [...listeners]) listener(event)
  })

  async function call<T>(op: string, ...args: readonly unknown[]): Promise<T> {
    const result = await bridge.request({ op, args })
    if (!result.ok) throw new Error(result.message)
    return result.value as T
  }

  return {
    snapshot: () => call<CatalogSnapshot>('snapshot'),
    open: (workspacePath: string) => call<void>('open', workspacePath),
    setReader: (settings: CatalogReaderSettings) => call<void>('setReader', settings),

    onEvent(listener: CatalogListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
