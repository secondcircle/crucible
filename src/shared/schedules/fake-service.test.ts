// @vitest-environment node
//
// The fake flavor's schedules: what an agent driving `npm run dev` meets on
// the board, and what the shell tests' seam behaves like. Nothing here reads
// a repository or touches a clock.
import { describe, expect, it } from 'vitest'
import { createFakeScheduleService } from './fake-service'
import type { ScheduleEvent } from './service'

const WORKSPACE = '/repos/crucible'

describe('the fake schedule service', () => {
  it('declares four schedules for the workspace it was given', async () => {
    const service = createFakeScheduleService({ workspacePath: WORKSPACE })
    const snapshot = await service.snapshot()

    expect(snapshot.workspaces).toHaveLength(1)
    const workspace = snapshot.workspaces[0]
    expect(workspace.workspacePath).toBe(WORKSPACE)
    expect(workspace.allPaused).toBe(false)
    expect(workspace.schedules.map((schedule) => schedule.workflow)).toEqual([
      'build',
      'changelog',
      'deps-audit',
      'issue-watch'
    ])
    // One of each thing the board has to draw: a gate, a warning, a pause.
    const watch = workspace.schedules.find((schedule) => schedule.workflow === 'issue-watch')
    expect(watch).toMatchObject({ hasCheck: true, cadence: 'every 5 min' })
    expect(watch?.warning?.kind).toBe('check')
    expect(
      workspace.schedules.find((schedule) => schedule.workflow === 'changelog')?.enabled
    ).toBe(false)
    service.dispose()
  })

  it('moves real state on a toggle and a pause, and announces the whole snapshot', async () => {
    const service = createFakeScheduleService({ workspacePath: WORKSPACE })
    const events: ScheduleEvent[] = []
    service.onEvent((event) => events.push(event))

    await service.setEnabled(WORKSPACE, 'build', false)
    await service.setAllPaused(WORKSPACE, true)

    expect(events).toHaveLength(2)
    const latest = events[1].snapshot.workspaces[0]
    expect(latest.allPaused).toBe(true)
    const build = latest.schedules.find((schedule) => schedule.workflow === 'build')
    expect(build?.enabled).toBe(false)
    // Paused, either way round: no next fire is named.
    expect(latest.schedules.every((schedule) => schedule.nextFireAt === undefined)).toBe(true)
    service.dispose()
  })

  it('fires whatever the launch handed it, and says so when it was handed nothing', async () => {
    const fired: string[] = []
    const service = createFakeScheduleService({
      workspacePath: WORKSPACE,
      fire: async (workspace, workflow) => {
        fired.push(`${workspace}:${workflow}`)
      }
    })

    await service.runNow(WORKSPACE, 'build')
    expect(fired).toEqual([`${WORKSPACE}:build`])

    const silent = createFakeScheduleService({ workspacePath: WORKSPACE })
    await expect(silent.runNow(WORKSPACE, 'build')).rejects.toThrow(/nothing to fire/)
    service.dispose()
    silent.dispose()
  })
})
