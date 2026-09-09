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
  // The scheduler announces a change after every evaluation, and it evaluates
  // every 30 seconds whether or not anything moved. An identical snapshot
  // tells a window nothing and costs it a whole re-render, so it is not sent.
  // The seam's contract is unchanged: a window still learns the whole state,
  // and a window that has just opened asks for it rather than waiting.
  let sent: string | undefined

  changes.subscribe(() => {
    const snapshot = scheduler.snapshot()
    const serialized = JSON.stringify(snapshot)
    if (serialized === sent) return
    sent = serialized
    const event = { type: 'schedules', snapshot } as const
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
