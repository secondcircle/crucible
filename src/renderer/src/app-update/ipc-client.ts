import type {
  AppUpdateListener,
  AppUpdateService,
  Unsubscribe
} from '../../../shared/app-update/service'
import { appUpdateBridge } from '../bridge'

// The renderer's side of the update channel. It holds no state: whether a
// newer build is waiting is a fact about the bundle on disk, and main watches
// that.

export function createAppUpdateClient(): AppUpdateService {
  const appUpdate = appUpdateBridge()
  const listeners = new Set<AppUpdateListener>()

  appUpdate.onEvent((event) => {
    for (const listener of [...listeners]) listener(event)
  })

  async function call<T>(op: string): Promise<T> {
    const result = await appUpdate.request({ op, args: [] })
    if (!result.ok) throw new Error(result.message)
    return result.value as T
  }

  return {
    pending: () => call<string | null>('pending'),
    restart: () => call<void>('restart'),

    onEvent(listener: AppUpdateListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
