import type { Unsubscribe } from '../../../shared/agent/port'
import type { LiveMonitor } from '../../../shared/monitors/monitor'
import type { MonitorListener, MonitorService } from '../../../shared/monitors/service'

// Answers the monitor seam the way main does but moves nothing by itself: a
// test replaces the live set and the event goes out whole, like the model's.
export interface ScriptedMonitors extends MonitorService {
  readonly calls: ReadonlyArray<{ readonly op: string; readonly args: readonly string[] }>
  setMonitors(monitors: readonly LiveMonitor[]): void
}

export function createScriptedMonitors(
  initial: readonly LiveMonitor[] = []
): ScriptedMonitors {
  let monitors = initial
  const listeners = new Set<MonitorListener>()
  const calls: Array<{ op: string; args: string[] }> = []

  return {
    calls,

    setMonitors(next: readonly LiveMonitor[]): void {
      monitors = next
      for (const listener of [...listeners]) {
        listener({ type: 'monitors', snapshot: { monitors } })
      }
    },

    async snapshot() {
      return { monitors }
    },

    onEvent(listener: MonitorListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async stop(monitorId: string) {
      calls.push({ op: 'stop', args: [monitorId] })
    }
  }
}
