import type {
  AppUpdateService,
  AppVersionListener,
  AppVersionState,
  Unsubscribe
} from '../../../shared/app-update/service'
import { appUpdateBridge } from '../bridge'

// The renderer's side of the version seam. It holds no state: which version
// runs, and whether a newer one is waiting on disk, are facts main owns.

export function createAppUpdateClient(): AppUpdateService {
  const appUpdate = appUpdateBridge()
  const listeners = new Set<AppVersionListener>()

  appUpdate.onEvent((state) => {
    for (const listener of [...listeners]) listener(state)
  })

  async function call<T>(op: string): Promise<T> {
    const result = await appUpdate.request({ op, args: [] })
    if (!result.ok) throw new Error(result.message)
    return result.value as T
  }

  return {
    state: () => call<AppVersionState>('state'),
    restart: () => call<void>('restart'),
    check: () => call<void>('check'),

    onEvent(listener: AppVersionListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
