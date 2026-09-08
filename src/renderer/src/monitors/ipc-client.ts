import type { Unsubscribe } from '../../../shared/agent/port'
import type {
  MonitorListener,
  MonitorService,
  MonitorsSnapshot
} from '../../../shared/monitors/service'
import { monitorsBridge } from '../bridge'

// The renderer's side of the monitor channel. It holds no state: the model's
// records are the truth and every event carries a whole snapshot.

export function createMonitorClient(): MonitorService {
  const bridge = monitorsBridge()
  const listeners = new Set<MonitorListener>()

  bridge.onEvent((event) => {
    for (const listener of [...listeners]) listener(event)
  })

  async function call<T>(op: string, ...args: readonly unknown[]): Promise<T> {
    const result = await bridge.request({ op, args })
    if (!result.ok) throw new Error(result.message)
    return result.value as T
  }

  return {
    snapshot: () => call<MonitorsSnapshot>('snapshot'),

    onEvent(listener: MonitorListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    stop: (monitorId: string) => call<void>('stop', monitorId)
  }
}
