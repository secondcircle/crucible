import { cadenceText, cronDue, nextCronSlot, parseCron } from '../../shared/schedules/cron'
import type {
  ScheduleView,
  SchedulesSnapshot,
  ScheduleWarning,
  WorkspaceSchedules
} from '../../shared/schedules/service'
import { runIsLive, type RunRecord } from '../../shared/workflows/run'
import {
  EMPTY_SCHEDULER_STATE,
  type SchedulerState,
  type SchedulerStore,
  type StoredSchedule
} from './state'

// The scheduler: when schedules fire, and nothing else. Its clock, its
// workflow listing, its run starting and its state persistence are all
// injected, so every rule below is provable with no app, no git and no real
// time — including ADR 0024's no-trace rule, which is only provable by
// observing that the run starter was never called.
//
// One instant governs a whole evaluation: dueness, consumption and the
// stamps a fire leaves are all measured against it, so a slow check cannot
// make a schedule due twice.

/** A schedule as the workflow files declare it, already read. */
export interface DeclaredSchedule {
  /** The workflow's name, which is its file name. */
  readonly workflow: string
  readonly description: string
  readonly cron: string
  // Whether the workflow declares inputs. A scheduled fire supplies none, so
  // a workflow that declares any is a schedule that can never fire.
  readonly declaresInputs: boolean
  /** The gate, when one is declared. Truthy fires; falsy leaves no trace. */
  readonly check?: (ctx: { readonly workspacePath: string }) => boolean | Promise<boolean>
}

export interface ScheduledFire {
  readonly workspacePath: string
  readonly workflow: string
}

export interface SchedulerOptions {
  /** The workspaces open in the sidebar, read fresh at every evaluation. */
  readonly workspaces: () => readonly string[]
  // Every repo workflow of this workspace that declares a schedule, read
  // fresh at every evaluation so an edited file is live by the next one.
  readonly declared: (workspacePath: string) => Promise<readonly DeclaredSchedule[]>
  /** Fires one run. Rejects with the kickoff failure, which becomes a warning. */
  readonly start: (fire: ScheduledFire) => Promise<unknown>
  /** Every run record the app knows: skip-if-live is decided from these. */
  readonly runs: () => Promise<readonly RunRecord[]>
  readonly store: SchedulerStore
  /** Epoch milliseconds. */
  readonly now: () => number
  /** Fired after any change a surface would show. */
  readonly onChanged: () => void
  readonly log?: (event: Record<string, unknown>) => void
  /** How long a check may take before it counts as a failure. */
  readonly checkMs?: number
  /** How often evaluation runs once `start()` is called; zero leaves it manual. */
  readonly tickMs?: number
}

export interface Scheduler {
  /** One pass over every open workspace's schedules. */
  evaluate(): Promise<void>
  /** Begins evaluating on the clock, starting with one pass right now. */
  begin(): void
  snapshot(): SchedulesSnapshot
  setEnabled(workspacePath: string, workflow: string, enabled: boolean): void
  setAllPaused(workspacePath: string, paused: boolean): void
  /** Fires now: the check is skipped, pauses are ignored, live runs are no bar. */
  runNow(workspacePath: string, workflow: string): Promise<void>
  dispose(): void
}

/** A check that takes longer than this has failed, whatever it is doing. */
const DEFAULT_CHECK_MS = 30_000

/** At least once a minute, with room for a slow evaluation (S1). */
const DEFAULT_TICK_MS = 30_000

const INPUTS_WARNING =
  'This workflow declares inputs, and a scheduled fire has nobody to supply them. ' +
  'It never fires on the clock; run it by hand with its inputs instead.'

export function createScheduler(options: SchedulerOptions): Scheduler {
  const {
    workspaces,
    declared,
    start,
    runs,
    store,
    now,
    onChanged,
    log,
    checkMs = DEFAULT_CHECK_MS,
    tickMs = DEFAULT_TICK_MS
  } = options

  let state: SchedulerState = store.load() ?? EMPTY_SCHEDULER_STATE
  // The last evaluation's declarations, which is what the board draws. Firing
  // never reads this: every evaluation asks the loader again.
  const seen = new Map<string, readonly DeclaredSchedule[]>()
  // Warning state, in memory: an evaluation rebuilds it, and a relaunch has
  // none until the first evaluation says otherwise.
  const warnings = new Map<string, ScheduleWarning>()
  let evaluating = false
  let timer: ReturnType<typeof setInterval> | undefined
  let disposed = false

  const keyOf = (workspacePath: string, workflow: string): string =>
    `${workspacePath}\u0000${workflow}`

  function stateOf(workspacePath: string, workflow: string): StoredSchedule | undefined {
    return state.workspaces[workspacePath]?.schedules[workflow]
  }

  function allPausedIn(workspacePath: string): boolean {
    return state.workspaces[workspacePath]?.allPaused === true
  }

  function enabledIn(workspacePath: string, workflow: string): boolean {
    return stateOf(workspacePath, workflow)?.enabled !== false
  }

  /** Writes one schedule's remembered state, whole, and persists it. */
  function remember(workspacePath: string, workflow: string, change: StoredSchedule): void {
    const workspace = state.workspaces[workspacePath] ?? { schedules: {} }
    state = {
      workspaces: {
        ...state.workspaces,
        [workspacePath]: {
          ...workspace,
          schedules: {
            ...workspace.schedules,
            [workflow]: { ...workspace.schedules[workflow], ...change }
          }
        }
      }
    }
    store.save(state)
  }

  function rememberWorkspace(workspacePath: string, allPaused: boolean): void {
    const workspace = state.workspaces[workspacePath] ?? { schedules: {} }
    state = {
      workspaces: { ...state.workspaces, [workspacePath]: { ...workspace, allPaused } }
    }
    store.save(state)
  }

  // Schedules the workspace no longer declares stop existing: their state goes
  // with them, so a schedule deleted and later re-added baselines afresh
  // rather than catching up on slots from before it came back.
  function forgetUndeclared(
    workspacePath: string,
    kept: readonly DeclaredSchedule[]
  ): void {
    const workspace = state.workspaces[workspacePath]
    if (workspace === undefined) return
    const names = new Set(kept.map((schedule) => schedule.workflow))
    const survivors = Object.entries(workspace.schedules).filter(([name]) => names.has(name))
    if (survivors.length === Object.keys(workspace.schedules).length) return
    for (const name of Object.keys(workspace.schedules)) {
      if (!names.has(name)) warnings.delete(keyOf(workspacePath, name))
    }
    state = {
      workspaces: {
        ...state.workspaces,
        [workspacePath]: { ...workspace, schedules: Object.fromEntries(survivors) }
      }
    }
    store.save(state)
  }

  /** Raises a warning, keeping the instant the condition first held. */
  function warn(
    workspacePath: string,
    workflow: string,
    kind: ScheduleWarning['kind'],
    message: string,
    at: number
  ): void {
    const key = keyOf(workspacePath, workflow)
    const standing = warnings.get(key)
    const since =
      standing !== undefined && standing.kind === kind
        ? standing.since
        : new Date(at).toISOString()
    warnings.set(key, { kind, message, since })
  }

  function clearWarning(workspacePath: string, workflow: string): void {
    warnings.delete(keyOf(workspacePath, workflow))
  }

  /** The gate's answer, bounded: anything but a clean truthy/falsy is an error. */
  async function askCheck(
    schedule: DeclaredSchedule,
    workspacePath: string
  ): Promise<{ readonly fire: boolean } | { readonly error: string }> {
    if (schedule.check === undefined) return { fire: true }
    let bound: ReturnType<typeof setTimeout> | undefined
    try {
      const answer = await Promise.race([
        Promise.resolve(schedule.check({ workspacePath })),
        new Promise<never>((_resolve, reject) => {
          bound = setTimeout(
            () => reject(new Error(`the check took longer than ${Math.round(checkMs / 1000)}s`)),
            checkMs
          )
        })
      ])
      return { fire: Boolean(answer) }
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) }
    } finally {
      if (bound !== undefined) clearTimeout(bound)
    }
  }

  /** The fire itself. A kickoff failure is the schedule's warning, never a throw at nobody. */
  async function fire(workspacePath: string, workflow: string, at: number): Promise<void> {
    try {
      await start({ workspacePath, workflow })
      clearWarning(workspacePath, workflow)
      log?.({ event: 'schedule_fired', workspace: workspacePath, workflow })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      warn(workspacePath, workflow, 'kickoff', message, at)
      log?.({ event: 'schedule_kickoff_failed', workspace: workspacePath, workflow, message })
      throw cause instanceof Error ? cause : new Error(message)
    }
  }

  /** A previous scheduled run of the same workflow in the same workspace, still live. */
  function liveAlready(
    records: readonly RunRecord[],
    workspacePath: string,
    workflow: string
  ): boolean {
    return records.some(
      (run) =>
        run.scheduled === true &&
        run.workspacePath === workspacePath &&
        run.workflow === workflow &&
        runIsLive(run)
    )
  }

  async function evaluateWorkspace(
    workspacePath: string,
    records: readonly RunRecord[],
    at: number
  ): Promise<void> {
    let schedules: readonly DeclaredSchedule[]
    try {
      schedules = await declared(workspacePath)
    } catch (cause) {
      // A listing that cannot be read leaves the last answer standing rather
      // than emptying the board on a transient failure.
      log?.({
        event: 'schedule_listing_failed',
        workspace: workspacePath,
        message: cause instanceof Error ? cause.message : String(cause)
      })
      return
    }
    seen.set(workspacePath, schedules)
    forgetUndeclared(workspacePath, schedules)

    for (const schedule of schedules) {
      await evaluateSchedule(workspacePath, schedule, records, at)
    }
  }

  async function evaluateSchedule(
    workspacePath: string,
    schedule: DeclaredSchedule,
    records: readonly RunRecord[],
    at: number
  ): Promise<void> {
    const { workflow } = schedule

    // A schedule that cannot fire by construction never consumes a slot and
    // never keeps an instant: it says why, and waits for the file to change.
    if (schedule.declaresInputs) {
      warn(workspacePath, workflow, 'inputs', INPUTS_WARNING, at)
      return
    }
    if (parseCron(schedule.cron) === undefined) {
      warn(
        workspacePath,
        workflow,
        'cron',
        `"${schedule.cron}" is not a cron expression Crucible fires: five numeric fields ` +
          '(minute hour day-of-month month day-of-week).',
        at
      )
      return
    }
    // A structural warning that no longer applies goes the moment the file is
    // right again; check and kickoff warnings are cleared by their own rules.
    const standing = warnings.get(keyOf(workspacePath, workflow))
    if (standing?.kind === 'cron' || standing?.kind === 'inputs') {
      clearWarning(workspacePath, workflow)
    }

    const remembered = stateOf(workspacePath, workflow)
    // Never seen here before: baselined now, due for nothing earlier.
    if (remembered?.lastConsidered === undefined) {
      remember(workspacePath, workflow, { lastConsidered: new Date(at).toISOString() })
      return
    }

    const last = Date.parse(remembered.lastConsidered)
    const from = Number.isNaN(last) ? at : last
    if (!cronDue(schedule.cron, from, at)) return

    const consume = (): void =>
      remember(workspacePath, workflow, { lastConsidered: new Date(at).toISOString() })

    // Paused, either way round: the slot is consumed silently, so re-enabling
    // resumes at the next future slot rather than firing for what was missed.
    if (allPausedIn(workspacePath) || !enabledIn(workspacePath, workflow)) {
      consume()
      return
    }

    // Skip-if-live: no fire, no queue, and the check is not evaluated at all.
    if (liveAlready(records, workspacePath, workflow)) {
      consume()
      log?.({ event: 'schedule_skipped_live', workspace: workspacePath, workflow })
      return
    }

    const gate = await askCheck(schedule, workspacePath)
    if ('error' in gate) {
      warn(workspacePath, workflow, 'check', gate.error, at)
      consume()
      log?.({
        event: 'schedule_check_failed',
        workspace: workspacePath,
        workflow,
        message: gate.error
      })
      return
    }
    // The gate answered, truthy or falsy: whatever a previous evaluation had
    // to say about the check is over.
    if (warnings.get(keyOf(workspacePath, workflow))?.kind === 'check') {
      clearWarning(workspacePath, workflow)
    }
    if (!gate.fire) {
      // Nothing exists anywhere: no run, no worktree, no board entry, and
      // nothing a user meets on the log.
      consume()
      return
    }

    consume()
    await fire(workspacePath, workflow, at).catch(() => {
      // Recorded as the schedule's warning inside fire(); a clock fire has
      // nobody to throw at.
    })
  }

  function viewOf(
    workspacePath: string,
    schedule: DeclaredSchedule,
    at: number
  ): ScheduleView {
    const warning = warnings.get(keyOf(workspacePath, schedule.workflow))
    const enabled = enabledIn(workspacePath, schedule.workflow)
    const paused = !enabled || allPausedIn(workspacePath)
    const cadence = cadenceText(schedule.cron)
    const cannotFire = warning?.kind === 'cron' || warning?.kind === 'inputs'
    const remembered = stateOf(workspacePath, schedule.workflow)?.lastConsidered
    const last = remembered === undefined ? at : Date.parse(remembered)
    // Measured from the last-considered instant, so a slot that passed while
    // the app was closed reads as due rather than as tomorrow.
    const next =
      paused || cannotFire
        ? undefined
        : nextCronSlot(schedule.cron, new Date(Number.isNaN(last) ? at : last))
    return {
      workflow: schedule.workflow,
      description: schedule.description,
      cron: schedule.cron,
      ...(cadence === undefined ? {} : { cadence }),
      hasCheck: schedule.check !== undefined,
      enabled,
      ...(next === undefined ? {} : { nextFireAt: next.toISOString() }),
      ...(warning === undefined ? {} : { warning })
    }
  }

  function snapshotNow(): SchedulesSnapshot {
    const at = now()
    const open = new Set(workspaces())
    const built: WorkspaceSchedules[] = []
    for (const [workspacePath, schedules] of seen) {
      // A workspace the user closed says nothing at all, chip included.
      if (!open.has(workspacePath)) continue
      built.push({
        workspacePath,
        allPaused: allPausedIn(workspacePath),
        schedules: [...schedules]
          .sort((left, right) => left.workflow.localeCompare(right.workflow))
          .map((schedule) => viewOf(workspacePath, schedule, at))
      })
    }
    return { workspaces: built }
  }

  // Evaluations never overlap: a slow check would otherwise be racing the
  // next pass over the same schedule.
  async function evaluate(): Promise<void> {
    if (evaluating || disposed) return
    evaluating = true
    try {
      const at = now()
      const records = await runs().catch((): readonly RunRecord[] => [])
      for (const workspacePath of workspaces()) {
        await evaluateWorkspace(workspacePath, records, at)
      }
    } finally {
      evaluating = false
      onChanged()
    }
  }

  return {
    evaluate,

    begin(): void {
      if (disposed || timer !== undefined) return
      // The first pass is the catch-up: whatever passed while Crucible was
      // closed is found here, and fires once.
      void evaluate()
      if (tickMs <= 0) return
      timer = setInterval(() => {
        void evaluate()
      }, tickMs)
    },

    snapshot: snapshotNow,

    setEnabled(workspacePath: string, workflow: string, enabled: boolean): void {
      remember(workspacePath, workflow, { enabled })
      onChanged()
    },

    setAllPaused(workspacePath: string, paused: boolean): void {
      rememberWorkspace(workspacePath, paused)
      onChanged()
    },

    async runNow(workspacePath: string, workflow: string): Promise<void> {
      const at = now()
      // Read fresh: the user asked now, so what the file says now is what
      // fires — and whether it can fire at all is decided from that.
      const schedules = await declared(workspacePath)
      seen.set(workspacePath, schedules)
      const schedule = schedules.find((candidate) => candidate.workflow === workflow)
      if (schedule === undefined) {
        throw new Error(`"${workflow}" declares no schedule in this workspace.`)
      }
      if (schedule.declaresInputs) throw new Error(INPUTS_WARNING)
      try {
        await fire(workspacePath, workflow, at)
      } finally {
        onChanged()
      }
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      warnings.clear()
      seen.clear()
    }
  }
}
