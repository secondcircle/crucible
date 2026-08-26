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
    dismiss: vi.fn(async () => {}),
    adopt: vi.fn(async () => {}),
    nodeTranscript: vi.fn(async () => []),
    artifact: vi.fn(async () => ({ kind: 'markdown' as const, body: '# spec', bytes: 6 })),
    revealArtifact: vi.fn(async () => {}),
    artifactFile: vi.fn(() => undefined),
    startScheduled: vi.fn(async () => {
      throw new Error('the channel never carries a scheduled fire')
    }),
    tools: {
      workflows: async () => '',
      start: async () => '',
      list: async () => '',
      answer: async () => '',
      resume: async () => ''
    },
    // Never crosses the channel: the hook is main's, consulted at a turn.
    turnStart: () => undefined,
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

  it('dispatches Dismiss and Investigate’s adoption, arguments checked', async () => {
    const service = serviceRecorder()
    await invoke(service, { op: 'dismiss', args: ['ab12'] })
    expect(service.dismiss).toHaveBeenCalledWith('ab12')
    await invoke(service, { op: 'adopt', args: ['ab12', 's7'] })
    expect(service.adopt).toHaveBeenCalledWith('ab12', 's7')

    await expect(invoke(service, { op: 'dismiss', args: [] })).rejects.toThrow(/needs text/)
    await expect(invoke(service, { op: 'adopt', args: ['ab12'] })).rejects.toThrow(/needs text/)
  })

  it('dispatches the artifact operations, both arguments checked', async () => {
    const service = serviceRecorder()
    await invoke(service, { op: 'artifact', args: ['ab12', '/state/ab12/artifacts/spec.md'] })
    expect(service.artifact).toHaveBeenCalledWith('ab12', '/state/ab12/artifacts/spec.md')
    await invoke(service, { op: 'revealArtifact', args: ['ab12', '/state/ab12/artifacts/spec.md'] })
    expect(service.revealArtifact).toHaveBeenCalledWith('ab12', '/state/ab12/artifacts/spec.md')

    await expect(invoke(service, { op: 'artifact', args: ['ab12'] })).rejects.toThrow(
      /needs text/
    )
    await expect(
      invoke(service, { op: 'revealArtifact', args: [{ path: '/etc/passwd' }, 'ab12'] })
    ).rejects.toThrow(/needs text/)
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
