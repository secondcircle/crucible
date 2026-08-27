// The seam the schedule board and its chip are driven through: the renderer
// sees this interface and nothing behind it, so a component test hands in a
// fake and the IPC client implements the same shape over the preload bridge.
//
// It answers what a schedule *is* — cadence, gate, toggle, next fire, warning
// — and nothing about runs. Parked state, last outcomes, Recent rows and the
// chip's needs-you count are all derived from run records on the existing run
// seam; this one never restates a run fact.

import type { Unsubscribe } from '../agent/port'

/** Why a schedule cannot be trusted right now, and since when. */
export interface ScheduleWarning {
  // What put the schedule here. `cron` and `inputs` are declarations that can
  // never fire; `check` and `kickoff` are failures of a fire that was tried.
  readonly kind: 'cron' | 'inputs' | 'check' | 'kickoff'
  /** One line, shown on the row in place of the last outcome. */
  readonly message: string
  /** ISO instant the condition first held, so the row can age it. */
  readonly since: string
}

/** One schedule of one workspace, as the board draws it. */
export interface ScheduleView {
  /** The workflow's name, which is its file name. */
  readonly workflow: string
  readonly description: string
  /** The expression as the workflow wrote it. */
  readonly cron: string
  /** The human reading, absent when the expression has none. */
  readonly cadence?: string
  readonly hasCheck: boolean
  readonly enabled: boolean
  // ISO of the next slot. Absent while the schedule is paused (its own toggle
  // or the workspace's), and absent when it cannot fire at all.
  readonly nextFireAt?: string
  readonly warning?: ScheduleWarning
}

export interface WorkspaceSchedules {
  /** The workspace checkout the schedules were declared in. */
  readonly workspacePath: string
  /** The workspace-wide pause, which outranks every per-schedule toggle. */
  readonly allPaused: boolean
  /** Sorted by workflow name, which is the board's own order. */
  readonly schedules: readonly ScheduleView[]
}

// Only workspaces the scheduler has actually evaluated appear: a workspace
// with no entry is one nothing has been answered for yet, which is why the
// chip is absent until then rather than flashing an empty state.
export interface SchedulesSnapshot {
  readonly workspaces: readonly WorkspaceSchedules[]
}

// The whole state after any change, like the run seam's: nothing is patched,
// so a dropped frame self-heals on the next one.
export type ScheduleEvent = {
  readonly type: 'schedules'
  readonly snapshot: SchedulesSnapshot
}

export type ScheduleListener = (event: ScheduleEvent) => void

export interface ScheduleService {
  snapshot(): Promise<SchedulesSnapshot>
  /** Live-only: no replay, no backlog. */
  onEvent(listener: ScheduleListener): Unsubscribe

  /** The per-schedule toggle: future clock fires only; a live run is untouched. */
  setEnabled(workspacePath: string, workflow: string, enabled: boolean): Promise<void>
  /** The workspace-wide pause: no schedule fires and no check runs while it is set. */
  setAllPaused(workspacePath: string, paused: boolean): Promise<void>
  // Fires the workflow now, check skipped and pauses ignored — the user asked.
  // Resolves when the run record exists; rejects with the kickoff failure.
  runNow(workspacePath: string, workflow: string): Promise<void>
}

/** What main holds beyond the channel. */
export interface MainScheduleService extends ScheduleService {
  dispose(): void
}
