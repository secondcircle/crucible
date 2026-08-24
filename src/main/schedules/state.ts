import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// What the scheduler remembers between launches, in Crucible's own state
// directory — never the repository, and never anything of π's.
// Per workspace path: each schedule's toggle, each schedule's last-considered
// instant, and the workspace's pause-all flag. Warning state is not here: it
// is rebuilt by the next evaluation.

export interface StoredSchedule {
  /** Absent means enabled, which is what a schedule nobody has touched is. */
  readonly enabled?: boolean
  // ISO. The instant dueness is measured from: a slot at or before it has
  // been dealt with, whether it fired, was skipped, or was consumed while
  // paused.
  readonly lastConsidered?: string
}

export interface StoredWorkspaceSchedules {
  readonly allPaused?: boolean
  /** Workflow name -> what is remembered about its schedule. */
  readonly schedules: Readonly<Record<string, StoredSchedule>>
}

export interface SchedulerState {
  /** Workspace checkout path -> its schedules' state. */
  readonly workspaces: Readonly<Record<string, StoredWorkspaceSchedules>>
}

export const EMPTY_SCHEDULER_STATE: SchedulerState = { workspaces: {} }

export interface SchedulerStore {
  load(): SchedulerState
  save(state: SchedulerState): void
}

/** What tests hand in: the same store with nothing on disk. */
export function memorySchedulerStore(
  initial: SchedulerState = EMPTY_SCHEDULER_STATE
): SchedulerStore & { current: SchedulerState } {
  const store = {
    current: initial,
    load: (): SchedulerState => store.current,
    save: (state: SchedulerState): void => {
      store.current = state
    }
  }
  return store
}

/** One JSON file, written whole and atomically, like every other store here. */
export function createSchedulerStore(
  path: string,
  onFailure?: (cause: unknown) => void
): SchedulerStore {
  return {
    load(): SchedulerState {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
        if (typeof parsed !== 'object' || parsed === null) return EMPTY_SCHEDULER_STATE
        const { workspaces } = parsed as { workspaces?: unknown }
        if (typeof workspaces !== 'object' || workspaces === null) return EMPTY_SCHEDULER_STATE
        return { workspaces: workspaces as SchedulerState['workspaces'] }
      } catch {
        // No file yet is the ordinary first launch, and an unreadable one is
        // the same thing as far as firing goes: every schedule baselines.
        return EMPTY_SCHEDULER_STATE
      }
    },

    save(state: SchedulerState): void {
      try {
        mkdirSync(dirname(path), { recursive: true })
        const scratch = `${path}.tmp`
        writeFileSync(scratch, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
        renameSync(scratch, path)
      } catch (cause) {
        // A state file that cannot be written must not stop the scheduler:
        // the launch keeps firing from memory and says so on the log.
        onFailure?.(cause)
      }
    }
  }
}
