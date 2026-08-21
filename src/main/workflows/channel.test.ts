// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { MainWorkflowRunService } from '../../shared/workflows/service'
import { invoke } from './channel'

function serviceRecorder(): MainWorkflowRunService {
  return {
    snapshot: vi.fn(async () => ({ runs: [] })),
    onEvent: () => () => {},
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    nodeTranscript: vi.fn(async () => []),
    tools: {
      workflows: async () => '',
      start: async () => '',
      list: async () => '',
      answer: async () => ''
    },
    toggleOverview: () => {},
    dispose: () => {}
  }
}

describe('the workflow-run channel', () => {
  it('dispatches the read and control operations', async () => {
    const service = serviceRecorder()
    await invoke(service, { op: 'snapshot', args: [] })
    expect(service.snapshot).toHaveBeenCalled()
    await invoke(service, { op: 'pause', args: ['ab12'] })
    expect(service.pause).toHaveBeenCalledWith('ab12')
    await invoke(service, { op: 'nodeTranscript', args: ['ab12', 'work'] })
    expect(service.nodeTranscript).toHaveBeenCalledWith('ab12', 'work')
  })

  it('refuses garbage rather than passing it through', async () => {
    const service = serviceRecorder()
    await expect(invoke(service, 'nonsense')).rejects.toThrow(/has to be an object/)
    await expect(invoke(service, { op: 'launchMissiles', args: [] })).rejects.toThrow(
      /does not do/
    )
    await expect(invoke(service, { op: 'pause', args: [7] })).rejects.toThrow(/needs text/)
  })
})
