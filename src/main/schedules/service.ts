import type { Unsubscribe } from '../../shared/agent/port'
import type {
  MainScheduleService,
  ScheduleListener,
  SchedulesSnapshot
} from '../../shared/schedules/service'
import type { Scheduler } from './scheduler'

// The live service: one scheduler, fanned out to whatever windows are up.
// Every rule about when a schedule fires lives in the scheduler; this module
// is address translation and event fan-out, exactly as the run service is
// over the engine.

export interface LiveScheduleOptions {
  readonly scheduler: Scheduler
  /** Called when the scheduler's state changed; wired to its onChanged. */
  readonly changes: { subscribe(listener: () => void): void }
}

export function createLiveScheduleService({
  scheduler,
  changes
}: LiveScheduleOptions): MainScheduleService {
  const listeners = new Set<ScheduleListener>()

  changes.subscribe(() => {
    const event = { type: 'schedules', snapshot: scheduler.snapshot() } as const
    for (const listener of [...listeners]) listener(event)
  })

  return {
    async snapshot(): Promise<SchedulesSnapshot> {
      return scheduler.snapshot()
    },

    onEvent(listener: ScheduleListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async setEnabled(workspacePath: string, workflow: string, enabled: boolean): Promise<void> {
      scheduler.setEnabled(workspacePath, workflow, enabled)
    },

    async setAllPaused(workspacePath: string, paused: boolean): Promise<void> {
      scheduler.setAllPaused(workspacePath, paused)
    },

    async runNow(workspacePath: string, workflow: string): Promise<void> {
      await scheduler.runNow(workspacePath, workflow)
    },

    dispose(): void {
      listeners.clear()
      scheduler.dispose()
    }
  }
}
