// @vitest-environment node
//
// When schedules fire, proved with no app, no git and no real time. The
// scheduler's clock, its workflow listing, its run starting and its state
// persistence are all injected, which is what makes "a falsy check leaves
// no trace" checkable at all: the only way to prove it left nothing is to
// watch the run starter never being called.
import { describe, expect, it } from 'vitest'
import type { RunRecord } from '../../shared/workflows/run'
import { createScheduler, type DeclaredSchedule, type ScheduledFire } from './scheduler'
import { memorySchedulerStore, type SchedulerState } from './state'

const WORKSPACE = '/repos/crucible'

/** A local instant, written the way a person reads a schedule. */
function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime()
}

function daily(overrides: Partial<DeclaredSchedule> = {}): DeclaredSchedule {
  return {
    workflow: 'triage',
    description: 'label and prioritize untriaged issues',
    cron: '0 9 * * *',
    declaresInputs: false,
    ...overrides
  }
}

interface Rig {
  readonly scheduler: ReturnType<typeof createScheduler>
  readonly fired: ScheduledFire[]
  readonly checked: number[]
  readonly store: ReturnType<typeof memorySchedulerStore>
  /** Moves the injected clock. */
  set(now: number): void
  runs(records: readonly RunRecord[]): void
  declare(schedules: readonly DeclaredSchedule[]): void
  /** The one workspace's view, as the board would draw it. */
  view(workflow: string): ReturnType<typeof viewOf>
}

type Views = ReturnType<typeof createScheduler>['snapshot']

function viewOf(snapshot: ReturnType<Views>, workflow: string) {
  return snapshot.workspaces[0]?.schedules.find((schedule) => schedule.workflow === workflow)
}

function rig(
  options: {
    readonly schedules?: readonly DeclaredSchedule[]
    readonly now?: number
    readonly state?: SchedulerState
    readonly start?: (fire: ScheduledFire) => Promise<unknown>
    readonly workspaces?: readonly string[]
    readonly checkMs?: number
  } = {}
): Rig {
  let now = options.now ?? at(2026, 8, 24, 12, 0)
  let declared = options.schedules ?? [daily()]
  let records: readonly RunRecord[] = []
  const fired: ScheduledFire[] = []
  const checked: number[] = []
  const store =
    options.state === undefined ? memorySchedulerStore() : memorySchedulerStore(options.state)
  const scheduler = createScheduler({
    workspaces: () => options.workspaces ?? [WORKSPACE],
    declared: async () =>
      declared.map((schedule) =>
        schedule.check === undefined
          ? schedule
          : {
              ...schedule,
              check: (ctx: { readonly workspacePath: string }) => {
                checked.push(now)
                return schedule.check?.(ctx) ?? false
              }
            }
      ),
    start:
      options.start ??
      (async (fire) => {
        fired.push(fire)
      }),
    runs: async () => records,
    store,
    now: () => now,
    onChanged: () => {},
    ...(options.checkMs === undefined ? {} : { checkMs: options.checkMs }),
    tickMs: 0
  })
  return {
    scheduler,
    fired,
    checked,
    store,
    set: (moment) => {
      now = moment
    },
    runs: (given) => {
      records = given
    },
    declare: (given) => {
      declared = given
    },
    view: (workflow) => viewOf(scheduler.snapshot(), workflow)
  }
}

function scheduledRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    workflow: 'triage',
    status: 'running',
    workspacePath: WORKSPACE,
    workspaceName: 'crucible',
    scheduled: true,
    inputs: {},
    nodes: [],
    createdAt: new Date(at(2026, 8, 24, 9, 0)).toISOString(),
    ...overrides
  }
}

describe('a schedule the scheduler has never seen', () => {
  it('is baselined at the current instant and fires for nothing earlier', async () => {
    const held = rig({ now: at(2026, 8, 24, 12, 0) })

    await held.scheduler.evaluate()

    expect(held.fired).toEqual([])
    // Baselined now, so the next slot is tomorrow's 9am rather than today's.
    expect(held.view('triage')?.nextFireAt).toBe(
      new Date(at(2026, 8, 25, 9, 0)).toISOString()
    )
    expect(held.store.current.workspaces[WORKSPACE]?.schedules.triage?.lastConsidered).toBe(
      new Date(at(2026, 8, 24, 12, 0)).toISOString()
    )
  })
})

describe('a due schedule', () => {
  it('fires once, and not again until the next slot passes', async () => {
    const held = rig({ now: at(2026, 8, 24, 8, 0) })
    await held.scheduler.evaluate()

    held.set(at(2026, 8, 24, 9, 1))
    await held.scheduler.evaluate()
    expect(held.fired).toEqual([{ workspacePath: WORKSPACE, workflow: 'triage' }])

    // Same day, past the slot: nothing new is due.
    held.set(at(2026, 8, 24, 17, 0))
    await held.scheduler.evaluate()
    expect(held.fired).toHaveLength(1)

    held.set(at(2026, 8, 25, 9, 30))
    await held.scheduler.evaluate()
    expect(held.fired).toHaveLength(2)
  })

  // One rule covers live operation and catch-up: being due produces one fire,
  // however many slots passed while Crucible was closed.
  it('fires once on catch-up, however many slots passed', async () => {
    const held = rig({
      now: at(2026, 8, 24, 12, 0),
      state: {
        workspaces: {
          [WORKSPACE]: {
            schedules: {
              triage: { lastConsidered: new Date(at(2026, 8, 1, 9, 0)).toISOString() }
            }
          }
        }
      }
    })

    await held.scheduler.evaluate()
    expect(held.fired).toHaveLength(1)

    // The fire is the new last-considered instant, so the twenty-three
    // missed mornings are gone rather than queued.
    await held.scheduler.evaluate()
    expect(held.fired).toHaveLength(1)
    expect(held.store.current.workspaces[WORKSPACE]?.schedules.triage?.lastConsidered).toBe(
      new Date(at(2026, 8, 24, 12, 0)).toISOString()
    )
  })
})

describe('skip-if-live', () => {
  it('consumes the slot, starts nothing, and never evaluates the check', async () => {
    const held = rig({
      now: at(2026, 8, 24, 8, 0),
      schedules: [daily({ check: () => true })]
    })
    await held.scheduler.evaluate()
    held.runs([scheduledRun({ status: 'running' })])

    held.set(at(2026, 8, 24, 9, 1))
    await held.scheduler.evaluate()

    expect(held.fired).toEqual([])
    expect(held.checked).toEqual([])

    // The next slot after the run settles fires normally.
    held.runs([scheduledRun({ status: 'complete' })])
    held.set(at(2026, 8, 25, 9, 1))
    await held.scheduler.evaluate()
    expect(held.fired).toHaveLength(1)
    expect(held.checked).toHaveLength(1)
  })

  it('looks only at scheduled runs of the same workflow in the same workspace', async () => {
    const held = rig({ now: at(2026, 8, 24, 8, 0) })
    await held.scheduler.evaluate()
    held.runs([
      // An agent's run of the same workflow: not a scheduled fire, no bar.
      scheduledRun({ id: 'r2', scheduled: undefined, sessionId: 's1' }),
      scheduledRun({ id: 'r3', workflow: 'deps-audit' }),
      scheduledRun({ id: 'r4', workspacePath: '/repos/other' })
    ])

    held.set(at(2026, 8, 24, 9, 1))
    await held.scheduler.evaluate()

    expect(held.fired).toHaveLength(1)
  })
})

describe('the check', () => {
  it('leaves no trace at all when it is falsy', async () => {
    const held = rig({ now: at(2026, 8, 24, 8, 0), schedules: [daily({ check: () => false })] })
    await held.scheduler.evaluate()
    const before = held.scheduler.snapshot()

    held.set(at(2026, 8, 24, 9, 1))
    await held.scheduler.evaluate()

    expect(held.checked).toHaveLength(1)
    expect(held.fired).toEqual([])
    expect(held.view('triage')?.warning).toBeUndefined()
    expect(held.scheduler.snapshot().workspaces[0]?.schedules[0]?.workflow).toBe(
      before.workspaces[0]?.schedules[0]?.workflow
    )
  })

  it('gates a catch-up fire exactly as it gates a live one', async () => {
    const held = rig({
      now: at(2026, 8, 24, 12, 0),
      schedules: [daily({ check: () => false })],
      state: {
        workspaces: {
          [WORKSPACE]: {
            schedules: {
              triage: { lastConsidered: new Date(at(2026, 8, 1, 9, 0)).toISOString() }
            }
          }
        }
      }
    })

    await held.scheduler.evaluate()

    expect(held.checked).toHaveLength(1)
    expect(held.fired).toEqual([])
  })

  it('puts the schedule in warning state when it throws, and keeps the first instant', async () => {
    let failing = true
    const held = rig({
      now: at(2026, 8, 24, 8, 0),
      schedules: [
        daily({
          check: () => {
            if (failing) throw new Error('403 from api.github.com')
            return false
          }
        })
      ]
    })
    await held.scheduler.evaluate()

    held.set(at(2026, 8, 24, 9, 1))
    await held.scheduler.evaluate()
    const warning = held.view('triage')?.warning
    expect(warning?.kind).toBe('check')
    expect(warning?.message).toContain('403 from api.github.com')
    expect(warning?.since).toBe(new Date(at(2026, 8, 24, 9, 1)).toISOString())
    expect(held.fired).toEqual([])

    // Still failing a day later: the instant it started failing stands, so
    // the board can say how long it has been going.
    held.set(at(2026, 8, 25, 9, 1))
    await held.scheduler.evaluate()
    expect(held.view('triage')?.warning?.since).toBe(
      new Date(at(2026, 8, 24, 9, 1)).toISOString()
    )

    // Cleared by the next evaluation that completes, falsy or truthy.
    failing = false
    held.set(at(2026, 8, 26, 9, 1))
    await held.scheduler.evaluate()
    expect(held.view('triage')?.warning).toBeUndefined()
  })

  it('counts a rejection and an overrun as failures too', async () => {
    const rejecting = rig({
      now: at(2026, 8, 24, 8, 0),
      schedules: [daily({ check: () => Promise.reject(new Error('the token expired')) })]
    })
    await rejecting.scheduler.evaluate()
    rejecting.set(at(2026, 8, 24, 9, 1))
    await rejecting.scheduler.evaluate()
    expect(rejecting.view('triage')?.warning?.message).toContain('the token expired')

    const hanging = rig({
      now: at(2026, 8, 24, 8, 0),
      checkMs: 5,
      schedules: [daily({ check: () => new Promise<boolean>(() => {}) })]
    })
    await hanging.scheduler.evaluate()
    hanging.set(at(2026, 8, 24, 9, 1))
    await hanging.scheduler.evaluate()
    expect(hanging.view('triage')?.warning?.kind).toBe('check')
    expect(hanging.fired).toEqual([])
  })
})

describe('the toggles', () => {
  it('consume slots silently and resume at the next future slot', async () => {
    const held = rig({ now: at(2026, 8, 24, 8, 0) })
    await held.scheduler.evaluate()
    held.scheduler.setEnabled(WORKSPACE, 'triage', false)

    held.set(at(2026, 8, 25, 12, 0))
    await held.scheduler.evaluate()
    expect(held.fired).toEqual([])
    // A paused schedule says so instead of naming a next fire.
    expect(held.view('triage')?.nextFireAt).toBeUndefined()
    expect(held.view('triage')?.enabled).toBe(false)

    held.scheduler.setEnabled(WORKSPACE, 'triage', true)
    // Re-enabled after slots passed: nothing fires for the ones missed.
    await held.scheduler.evaluate()
    expect(held.fired).toEqual([])

    held.set(at(2026, 8, 26, 9, 1))
    await held.scheduler.evaluate()
    expect(held.fired).toHaveLength(1)
  })

  it('pause-all stops every schedule and evaluates no check', async () => {
    const held = rig({
      now: at(2026, 8, 24, 8, 0),
      schedules: [daily({ check: () => true }), daily({ workflow: 'deps-audit' })]
    })
    await held.scheduler.evaluate()
    held.scheduler.setAllPaused(WORKSPACE, true)

    held.set(at(2026, 8, 24, 9, 1))
    await held.scheduler.evaluate()

    expect(held.fired).toEqual([])
    expect(held.checked).toEqual([])
    expect(held.scheduler.snapshot().workspaces[0]?.allPaused).toBe(true)
    // The per-schedule toggles keep their own state underneath.
    expect(held.view('triage')?.enabled).toBe(true)
  })
})

describe('run now', () => {
  it('fires whatever the check says, whatever the pauses say, beside a live run', async () => {
    const held = rig({
      now: at(2026, 8, 24, 12, 0),
      schedules: [daily({ check: () => false })]
    })
    await held.scheduler.evaluate()
    held.scheduler.setAllPaused(WORKSPACE, true)
    held.scheduler.setEnabled(WORKSPACE, 'triage', false)
    held.runs([scheduledRun({ status: 'running' })])

    await held.scheduler.runNow(WORKSPACE, 'triage')

    expect(held.fired).toEqual([{ workspacePath: WORKSPACE, workflow: 'triage' }])
    expect(held.checked).toEqual([])
    // The cadence is untouched: a manual fire consumes no clock slot.
    expect(held.store.current.workspaces[WORKSPACE]?.schedules.triage?.lastConsidered).toBe(
      new Date(at(2026, 8, 24, 12, 0)).toISOString()
    )
  })

  it('refuses a workflow this workspace declares no schedule for', async () => {
    const held = rig()
    await expect(held.scheduler.runNow(WORKSPACE, 'nothing-here')).rejects.toThrow(
      /declares no schedule/
    )
  })
})

describe('run now beside a standing check warning', () => {
  // Run now skips the check entirely, so it says nothing about the check:
  // the warning and its first-failure instant must stand until an evaluation
  // actually completes.
  it('leaves the warning and its first-failure instant standing', async () => {
    const held = rig({
      now: at(2026, 8, 24, 8, 0),
      schedules: [
        daily({
          check: () => {
            throw new Error('403 from api.github.com')
          }
        })
      ]
    })
    await held.scheduler.evaluate()
    held.set(at(2026, 8, 24, 9, 1))
    await held.scheduler.evaluate()
    expect(held.view('triage')?.warning?.kind).toBe('check')
    const since = held.view('triage')?.warning?.since

    held.set(at(2026, 8, 24, 10, 0))
    await held.scheduler.runNow(WORKSPACE, 'triage')
    expect(held.fired).toHaveLength(1)

    // The check is still broken and no evaluation has completed since the
    // manual fire: the warning stands, aged from its first failure.
    expect(held.view('triage')?.warning?.kind).toBe('check')
    expect(held.view('triage')?.warning?.since).toBe(since)
  })

  // A schedule shows one warning at a time, so a manual fire that fails takes
  // the cell. The check's first-failure instant must survive that: when the
  // check warning comes back it is still aged from when the check broke.
  it('shows a failed manual kickoff without losing when the check first broke', async () => {
    const held = rig({
      now: at(2026, 8, 24, 8, 0),
      schedules: [
        daily({
          check: () => {
            throw new Error('403 from api.github.com')
          }
        })
      ],
      start: async () => {
        throw new Error('no origin/HEAD, main or master')
      }
    })
    await held.scheduler.evaluate()
    held.set(at(2026, 8, 24, 9, 1))
    await held.scheduler.evaluate()
    const since = held.view('triage')?.warning?.since

    held.set(at(2026, 8, 24, 10, 0))
    await expect(held.scheduler.runNow(WORKSPACE, 'triage')).rejects.toThrow(/origin\/HEAD/)
    expect(held.view('triage')?.warning?.kind).toBe('kickoff')

    held.set(at(2026, 8, 25, 9, 1))
    await held.scheduler.evaluate()
    expect(held.view('triage')?.warning?.kind).toBe('check')
    expect(held.view('triage')?.warning?.since).toBe(since)
  })

  // The same rule from the other side: Run now ignores the cron, so a fire
  // that works says nothing about an expression Crucible still cannot parse.
  // Only the file changing clears that one.
  it('leaves an unparsable cron saying so', async () => {
    const held = rig({ now: at(2026, 8, 24, 8, 0), schedules: [daily({ cron: 'nonsense' })] })
    await held.scheduler.evaluate()
    const since = held.view('triage')?.warning?.since

    held.set(at(2026, 8, 24, 10, 0))
    await held.scheduler.runNow(WORKSPACE, 'triage')

    expect(held.fired).toHaveLength(1)
    expect(held.view('triage')?.warning?.kind).toBe('cron')
    expect(held.view('triage')?.warning?.since).toBe(since)
  })
})

describe('a schedule that cannot fire', () => {
  it('says why, never fires, and shows no next fire', async () => {
    const held = rig({
      now: at(2026, 8, 24, 8, 0),
      schedules: [
        daily({ workflow: 'broken', cron: 'every morning' }),
        daily({ workflow: 'needy', declaresInputs: true })
      ]
    })

    await held.scheduler.evaluate()
    held.set(at(2026, 8, 25, 12, 0))
    await held.scheduler.evaluate()

    expect(held.fired).toEqual([])
    expect(held.view('broken')?.warning?.kind).toBe('cron')
    expect(held.view('broken')?.nextFireAt).toBeUndefined()
    expect(held.view('needy')?.warning?.kind).toBe('inputs')
    expect(held.view('needy')?.warning?.message).toContain('nobody to supply them')
    // Nor by hand: a scheduled fire has nobody to supply inputs, whoever asked.
    await expect(held.scheduler.runNow(WORKSPACE, 'needy')).rejects.toThrow(/nobody to supply/)
  })

  it('clears the warning once the file is right again', async () => {
    const held = rig({ now: at(2026, 8, 24, 8, 0), schedules: [daily({ cron: 'nonsense' })] })
    await held.scheduler.evaluate()
    expect(held.view('triage')?.warning?.kind).toBe('cron')

    held.declare([daily()])
    await held.scheduler.evaluate()
    expect(held.view('triage')?.warning).toBeUndefined()
  })
})

describe('a kickoff that fails', () => {
  it('lands as the warning on its schedule, with the slot consumed', async () => {
    let broken = true
    const held = rig({
      now: at(2026, 8, 24, 8, 0),
      start: async () => {
        if (broken) throw new Error('no origin/HEAD, main or master')
        return undefined
      }
    })
    await held.scheduler.evaluate()

    held.set(at(2026, 8, 24, 9, 1))
    await held.scheduler.evaluate()
    expect(held.view('triage')?.warning?.kind).toBe('kickoff')
    expect(held.view('triage')?.warning?.message).toContain('origin/HEAD')

    // Consumed: the same slot is not tried again on the next evaluation.
    held.set(at(2026, 8, 24, 9, 30))
    await held.scheduler.evaluate()
    expect(held.view('triage')?.warning?.kind).toBe('kickoff')

    // A fire that works clears it.
    broken = false
    held.set(at(2026, 8, 25, 9, 1))
    await held.scheduler.evaluate()
    expect(held.view('triage')?.warning).toBeUndefined()
  })
})

describe('the state', () => {
  it('round-trips through the persistence seam, and a relaunch catches up once', async () => {
    const first = rig({ now: at(2026, 8, 24, 8, 0) })
    await first.scheduler.evaluate()
    first.set(at(2026, 8, 24, 9, 1))
    await first.scheduler.evaluate()
    expect(first.fired).toHaveLength(1)
    const persisted = first.store.current

    // A new launch, days later, reading the same file.
    const second = rig({ now: at(2026, 8, 28, 12, 0), state: persisted })
    await second.scheduler.evaluate()
    expect(second.fired).toHaveLength(1)
    await second.scheduler.evaluate()
    expect(second.fired).toHaveLength(1)
  })

  it('forgets a schedule the workspace no longer declares', async () => {
    const held = rig({ now: at(2026, 8, 24, 8, 0) })
    await held.scheduler.evaluate()
    expect(held.store.current.workspaces[WORKSPACE]?.schedules.triage).toBeDefined()

    held.declare([])
    await held.scheduler.evaluate()

    expect(held.store.current.workspaces[WORKSPACE]?.schedules.triage).toBeUndefined()
    expect(held.scheduler.snapshot().workspaces[0]?.schedules).toEqual([])
  })

  it('answers for open workspaces only', async () => {
    const held = rig({ now: at(2026, 8, 24, 8, 0), workspaces: [] })
    await held.scheduler.evaluate()
    expect(held.scheduler.snapshot().workspaces).toEqual([])
  })
})

describe('the snapshot', () => {
  it('carries what the board draws: cadence, gate, toggle and next fire', async () => {
    const held = rig({
      now: at(2026, 8, 24, 12, 0),
      schedules: [daily({ check: () => true })]
    })
    await held.scheduler.evaluate()

    expect(held.view('triage')).toMatchObject({
      workflow: 'triage',
      description: 'label and prioritize untriaged issues',
      cron: '0 9 * * *',
      cadence: 'daily 09:00',
      hasCheck: true,
      enabled: true
    })
  })

  it('sorts by workflow name, which is the order the board draws', async () => {
    const held = rig({
      schedules: [daily({ workflow: 'triage' }), daily({ workflow: 'changelog' })]
    })
    await held.scheduler.evaluate()
    expect(
      held.scheduler.snapshot().workspaces[0]?.schedules.map((schedule) => schedule.workflow)
    ).toEqual(['changelog', 'triage'])
  })

  // A slot that passed while Crucible was closed is what the row reads as
  // due: it fires at the next evaluation, not tomorrow morning.
  it('measures the next fire from the last-considered instant', async () => {
    const held = rig({
      now: at(2026, 8, 24, 12, 0),
      state: {
        workspaces: {
          [WORKSPACE]: {
            schedules: {
              triage: { lastConsidered: new Date(at(2026, 8, 20, 12, 0)).toISOString() },
              // Disabled: no next fire at all, however many slots passed.
              changelog: {
                enabled: false,
                lastConsidered: new Date(at(2026, 8, 20, 12, 0)).toISOString()
              }
            }
          }
        }
      },
      schedules: [daily(), daily({ workflow: 'changelog' })],
      // Nothing fires here: the snapshot is taken before any evaluation, which
      // is the moment a relaunch is read in.
      start: async () => {
        throw new Error('nothing should fire in this test')
      }
    })

    held.declare([daily(), daily({ workflow: 'changelog' })])
    await held.scheduler.runNow(WORKSPACE, 'triage').catch(() => {})

    expect(held.view('triage')?.nextFireAt).toBe(
      new Date(at(2026, 8, 21, 9, 0)).toISOString()
    )
    expect(held.view('changelog')?.nextFireAt).toBeUndefined()
  })
})
