import type { Unsubscribe } from '../agent/port'
import { cadenceText, nextCronSlot } from './cron'
import type {
  MainScheduleService,
  ScheduleListener,
  SchedulesSnapshot,
  ScheduleView,
  ScheduleWarning
} from './service'

// The fake flavor's schedules: four canned ones for the workspace the canned
// runs claim, so the chip, the board and its controls are all drivable under
// `npm run dev` with nothing on a clock and no repository read. Toggles and
// pause-all move real state here; Run now asks whatever main handed in.

/** How long the canned check has been failing, which the board ages. */
const CHECK_FAILING_HOURS = 3

interface CannedSchedule {
  readonly workflow: string
  readonly description: string
  readonly cron: string
  readonly hasCheck: boolean
  readonly enabled: boolean
  readonly warning?: (now: number) => ScheduleWarning
}

const CANNED: readonly CannedSchedule[] = [
  {
    workflow: 'build',
    description: 'take an intent document to built code',
    cron: '0 9 * * *',
    hasCheck: false,
    enabled: true
  },
  {
    workflow: 'changelog',
    description: "draft notes from the week's merges",
    cron: '0 16 * * 5',
    hasCheck: false,
    // Paused by hand, so the board has a dimmed row reading "paused".
    enabled: false
  },
  {
    workflow: 'deps-audit',
    description: 'flag risky dependency updates',
    cron: '0 7 * * 1',
    hasCheck: false,
    enabled: true
  },
  {
    workflow: 'issue-watch',
    description: 'triage new issues as they appear',
    cron: '*/5 * * * *',
    hasCheck: true,
    enabled: true,
    warning: (now) => ({
      kind: 'check',
      message: '403 from api.github.com',
      since: new Date(now - CHECK_FAILING_HOURS * 3_600_000).toISOString()
    })
  }
]

export interface FakeScheduleOptions {
  /** The workspace the canned schedules are declared in. */
  readonly workspacePath?: string
  /** What Run now does; absent leaves it refusing honestly. */
  readonly fire?: (workspacePath: string, workflow: string) => Promise<unknown>
  readonly now?: () => number
}

export function createFakeScheduleService({
  workspacePath = '/fake/resume-site',
  fire,
  now = () => Date.now()
}: FakeScheduleOptions = {}): MainScheduleService {
  const listeners = new Set<ScheduleListener>()
  const enabled = new Map<string, boolean>(
    CANNED.map((schedule) => [schedule.workflow, schedule.enabled])
  )
  let allPaused = false

  function viewOf(schedule: CannedSchedule): ScheduleView {
    const at = now()
    const on = enabled.get(schedule.workflow) !== false
    const paused = !on || allPaused
    const cadence = cadenceText(schedule.cron)
    const next = paused ? undefined : nextCronSlot(schedule.cron, new Date(at))
    const warning = schedule.warning?.(at)
    return {
      workflow: schedule.workflow,
      description: schedule.description,
      cron: schedule.cron,
      ...(cadence === undefined ? {} : { cadence }),
      hasCheck: schedule.hasCheck,
      enabled: on,
      ...(next === undefined ? {} : { nextFireAt: next.toISOString() }),
      ...(warning === undefined ? {} : { warning })
    }
  }

  function snapshotNow(): SchedulesSnapshot {
    return {
      workspaces: [
        {
          workspacePath,
          allPaused,
          schedules: CANNED.map(viewOf)
        }
      ]
    }
  }

  function changed(): void {
    const event = { type: 'schedules', snapshot: snapshotNow() } as const
    for (const listener of [...listeners]) listener(event)
  }

  return {
    async snapshot(): Promise<SchedulesSnapshot> {
      return snapshotNow()
    },

    onEvent(listener: ScheduleListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async setEnabled(_workspacePath: string, workflow: string, on: boolean): Promise<void> {
      enabled.set(workflow, on)
      changed()
    },

    async setAllPaused(_workspacePath: string, paused: boolean): Promise<void> {
      allPaused = paused
      changed()
    },

    async runNow(workspace: string, workflow: string): Promise<void> {
      if (fire === undefined) {
        throw new Error('This launch has nothing to fire a scheduled run with.')
      }
      await fire(workspace, workflow)
      changed()
    },

    dispose(): void {
      listeners.clear()
    }
  }
}
