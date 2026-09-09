// @vitest-environment node
//
// The fan-out, with a scheduler stubbed to whatever snapshot the test wants:
// what a window is told, and what it is spared.
import { describe, expect, it, vi } from 'vitest'
import type { SchedulesSnapshot } from '../../shared/schedules/service'
import { createLiveScheduleService } from './service'
import type { Scheduler } from './scheduler'

function board(nextFireAt: string): SchedulesSnapshot {
  return {
    workspaces: [
      {
        workspacePath: '/repos/crucible',
        allPaused: false,
        schedules: [
          {
            workflow: 'triage',
            description: 'the triage workflow',
            cron: '0 9 * * *',
            hasCheck: true,
            enabled: true,
            nextFireAt
          }
        ]
      }
    ]
  }
}

function stub(snapshot: () => SchedulesSnapshot): {
  scheduler: Scheduler
  announce: () => void
  service: ReturnType<typeof createLiveScheduleService>
} {
  const scheduler = {
    evaluate: vi.fn(async () => {}),
    begin: vi.fn(),
    snapshot,
    setEnabled: vi.fn(),
    setAllPaused: vi.fn(),
    runNow: vi.fn(async () => {}),
    dispose: vi.fn()
  } satisfies Scheduler
  let announce = (): void => {}
  const service = createLiveScheduleService({
    scheduler,
    changes: {
      subscribe(listener) {
        announce = listener
      }
    }
  })
  return { scheduler, announce: () => announce(), service }
}

describe('the schedule seam', () => {
  it('sends a snapshot when the board moved', () => {
    let at = '2026-08-21T09:00:00.000Z'
    const { announce, service } = stub(() => board(at))
    const heard: SchedulesSnapshot[] = []
    service.onEvent((event) => heard.push(event.snapshot))

    announce()
    at = '2026-08-22T09:00:00.000Z'
    announce()

    expect(heard.map((snapshot) => snapshot.workspaces[0].schedules[0].nextFireAt)).toEqual([
      '2026-08-21T09:00:00.000Z',
      '2026-08-22T09:00:00.000Z'
    ])
  })

  // The scheduler announces after every evaluation, and it evaluates every
  // 30 seconds whether or not anything moved. An identical snapshot tells a
  // window nothing and costs it a full re-render.
  it('says nothing when the evaluation changed nothing', () => {
    const { announce, service } = stub(() => board('2026-08-21T09:00:00.000Z'))
    const heard: SchedulesSnapshot[] = []
    service.onEvent((event) => heard.push(event.snapshot))

    announce()
    announce()
    announce()

    expect(heard).toHaveLength(1)
  })

  // Self-healing is what the seam promises, so a window that arrives between
  // two identical evaluations must still be able to get the whole state.
  it('still answers a snapshot request with the state as it stands', async () => {
    const { announce, service } = stub(() => board('2026-08-21T09:00:00.000Z'))
    announce()

    await expect(service.snapshot()).resolves.toEqual(board('2026-08-21T09:00:00.000Z'))
  })
})
