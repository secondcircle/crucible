import { join } from 'node:path'
import { createFakeScheduleService } from '../../shared/schedules/fake-service'
import type { MainScheduleService } from '../../shared/schedules/service'
import type { MainWorkflowRunService } from '../../shared/workflows/service'
import type { Flavor } from '../agent/select-adapter'
import type { LogSink } from '../log/sink'
import { shippedWorkflowLoader } from '../workflows/select-service'
import { createScheduler, type Scheduler } from './scheduler'
import { createLiveScheduleService } from './service'
import { loaderSchedules } from './source'
import { createSchedulerStore } from './state'

// One flavor decision governs every seam, and this one is chosen exactly as
// the run seam is: a fake-flavor launch answers with canned schedules, reads
// no workflow folder, evaluates no check and never touches a clock.
//
// The scheduler itself knows nothing of flavors: it constructs no adapter,
// asks its injected seams for everything, and behaves the same wherever it
// runs — which is why `npm test` covers every one of its rules with fakes and
// no launch of any kind.

export interface ScheduleWiring {
  readonly appPath: string
  /** Crucible's own state directory; the scheduler's state lives under it. */
  readonly stateDir: string
  /** The workspaces open in the sidebar, read fresh at every evaluation. */
  readonly workspaces: () => readonly string[]
  /** The run seam: what fires a scheduled run, and what the records say. */
  readonly runs: MainWorkflowRunService
  // Fake flavor only: the workspace the canned schedules are declared in. It
  // is the same directory the canned runs claim, so the chip, the board and
  // its rows all belong to one workspace the sidebar can hold.
  readonly cannedWorkspacePath?: string
}

export interface SelectedScheduleService {
  readonly service: MainScheduleService
  /** Absent in the fake flavor, where nothing evaluates on a clock. */
  readonly scheduler?: Scheduler
}

export function selectScheduleService(
  flavor: Flavor,
  log: LogSink,
  wiring: ScheduleWiring
): SelectedScheduleService {
  log.append({ source: 'main', event: 'schedule_service_selected', service: flavor })

  if (flavor !== 'sdk') {
    const workspacePath = wiring.cannedWorkspacePath ?? wiring.workspaces()[0]
    return {
      service: createFakeScheduleService({
        ...(workspacePath === undefined ? {} : { workspacePath }),
        fire: (workspace, workflow) =>
          wiring.runs.startScheduled({ workspacePath: workspace, workflow })
      })
    }
  }

  const loader = shippedWorkflowLoader(wiring.appPath, log)

  const changeListeners = new Set<() => void>()
  const scheduler = createScheduler({
    workspaces: wiring.workspaces,
    declared: loaderSchedules(loader),
    start: (fire) => wiring.runs.startScheduled(fire),
    runs: async () => (await wiring.runs.snapshot()).runs,
    store: createSchedulerStore(join(wiring.stateDir, 'schedules.json'), (cause) => {
      log.append({
        source: 'main',
        event: 'scheduler_state_write_failed',
        message: cause instanceof Error ? cause.message : String(cause)
      })
    }),
    now: () => Date.now(),
    onChanged: () => {
      for (const listener of [...changeListeners]) listener()
    },
    log: (event) => log.append({ source: 'main', event: 'scheduler', ...event })
  })

  return {
    service: createLiveScheduleService({
      scheduler,
      changes: {
        subscribe(listener: () => void): void {
          changeListeners.add(listener)
        }
      }
    }),
    scheduler
  }
}
