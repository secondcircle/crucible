import type {
  ScheduleListener,
  ScheduleService,
  SchedulesSnapshot
} from '../../../shared/schedules/service'

// Answers the schedule seam the way main does but moves nothing by itself: a
// test sets the snapshot and the event goes out whole, like the scheduler's.
// Every board and chip behavior is provable against this, with no main
// process and nothing on a clock.

export interface ScriptedSchedules extends ScheduleService {
  readonly calls: ReadonlyArray<{
    readonly op: string
    readonly args: readonly (string | boolean)[]
  }>
  /** Replaces the snapshot and announces it. */
  setSnapshot(snapshot: SchedulesSnapshot): void
  /** What `runNow` does; by default it resolves at once. */
  runNowAnswers(answer: () => Promise<void>): void
}

export function createScriptedSchedules(
  initial: SchedulesSnapshot = { workspaces: [] }
): ScriptedSchedules {
  let snapshot = initial
  let runNowAnswer: () => Promise<void> = async () => {}
  const listeners = new Set<ScheduleListener>()
  const calls: Array<{ op: string; args: (string | boolean)[] }> = []

  return {
    calls,

    setSnapshot(next: SchedulesSnapshot): void {
      snapshot = next
      for (const listener of [...listeners]) listener({ type: 'schedules', snapshot })
    },

    runNowAnswers(answer: () => Promise<void>): void {
      runNowAnswer = answer
    },

    async snapshot() {
      return snapshot
    },

    onEvent(listener: ScheduleListener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async setEnabled(workspacePath: string, workflow: string, enabled: boolean) {
      calls.push({ op: 'setEnabled', args: [workspacePath, workflow, enabled] })
    },

    async setAllPaused(workspacePath: string, paused: boolean) {
      calls.push({ op: 'setAllPaused', args: [workspacePath, paused] })
    },

    async runNow(workspacePath: string, workflow: string) {
      calls.push({ op: 'runNow', args: [workspacePath, workflow] })
      await runNowAnswer()
    }
  }
}
