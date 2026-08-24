// @vitest-environment node
//
// Plumbing only, checked as plumbing: names dispatch, malformed requests are
// refused, and nothing about when a schedule fires lives here.
import { describe, expect, it, vi } from 'vitest'
import type { MainScheduleService } from '../../shared/schedules/service'
import { invoke } from './channel'

function serviceRecorder(): MainScheduleService {
  return {
    snapshot: vi.fn(async () => ({ workspaces: [] })),
    onEvent: () => () => {},
    setEnabled: vi.fn(async () => {}),
    setAllPaused: vi.fn(async () => {}),
    runNow: vi.fn(async () => {}),
    dispose: () => {}
  }
}

describe('the schedule channel', () => {
  it('dispatches the read and the three commands', async () => {
    const service = serviceRecorder()

    await invoke(service, { op: 'snapshot', args: [] })
    expect(service.snapshot).toHaveBeenCalled()

    await invoke(service, { op: 'setEnabled', args: ['/repos/crucible', 'triage', false] })
    expect(service.setEnabled).toHaveBeenCalledWith('/repos/crucible', 'triage', false)

    await invoke(service, { op: 'setAllPaused', args: ['/repos/crucible', true] })
    expect(service.setAllPaused).toHaveBeenCalledWith('/repos/crucible', true)

    await invoke(service, { op: 'runNow', args: ['/repos/crucible', 'triage'] })
    expect(service.runNow).toHaveBeenCalledWith('/repos/crucible', 'triage')
  })

  it('refuses anything it was not asked in the shape it takes', async () => {
    const service = serviceRecorder()
    await expect(invoke(service, 'snapshot')).rejects.toThrow(/has to be an object/)
    await expect(invoke(service, {})).rejects.toThrow(/name an operation/)
    await expect(invoke(service, { op: 'setEnabled', args: [1, 2, 3] })).rejects.toThrow(
      /needs text/
    )
    await expect(
      invoke(service, { op: 'setAllPaused', args: ['/repos/crucible', 'yes'] })
    ).rejects.toThrow(/yes or no/)
    await expect(invoke(service, { op: 'fireEverything', args: [] })).rejects.toThrow(
      /does not do/
    )
  })
})
