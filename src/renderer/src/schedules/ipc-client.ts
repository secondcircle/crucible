import type { Unsubscribe } from '../../../shared/agent/port'
import type {
  ScheduleListener,
  ScheduleService,
  SchedulesSnapshot
} from '../../../shared/schedules/service'
import { schedulesBridge } from '../bridge'

// The renderer's side of the schedule channel. It holds no state: the
// scheduler's answer is the truth and every event carries a whole snapshot.

export function createScheduleClient(): ScheduleService {
  const bridge = schedulesBridge()
  const listeners = new Set<ScheduleListener>()

  bridge.onEvent((event) => {
    for (const listener of [...listeners]) listener(event)
  })

  async function call<T>(op: string, ...args: readonly unknown[]): Promise<T> {
    const result = await bridge.request({ op, args })
    if (!result.ok) throw new Error(result.message)
    return result.value as T
  }

  return {
    snapshot: () => call<SchedulesSnapshot>('snapshot'),

    onEvent(listener: ScheduleListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    setEnabled: (workspacePath: string, workflow: string, enabled: boolean) =>
      call<void>('setEnabled', workspacePath, workflow, enabled),
    setAllPaused: (workspacePath: string, paused: boolean) =>
      call<void>('setAllPaused', workspacePath, paused),
    runNow: (workspacePath: string, workflow: string) =>
      call<void>('runNow', workspacePath, workflow)
  }
}
