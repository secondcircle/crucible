// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { TranscriptItem } from '../../shared/agent/port'
import type { RunRecord } from '../../shared/workflows/run'
import type { WorkflowRunEvent } from '../../shared/workflows/service'
import type { StartRunRequest, WorkflowEngine } from './engine'
import type { LoadedWorkflow, WorkflowLoader } from './loader'
import { createLiveWorkflowRunService } from './service'

function record(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: 'ab12',
    workflow: 'adhoc',
    status: 'running',
    workspacePath: '/repos/thing',
    workspaceName: 'thing',
    sessionId: 's1',
    branch: 'crucible/run-ab12',
    inputs: {},
    nodes: [
      {
        id: 'work',
        status: 'running',
        parents: [],
        reads: [],
        artifacts: [],
        cost: 1.25
      }
    ],
    createdAt: '2026-08-20T10:00:00.000Z',
    startedAt: '2026-08-20T10:00:00.000Z',
    ...overrides
  }
}

function engineOf(runs: RunRecord[]): WorkflowEngine & { started: StartRunRequest[] } {
  const started: StartRunRequest[] = []
  return {
    started,
    runs: () => runs,
    async start(request) {
      started.push(request)
      return record({ id: 'new1' })
    },
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    dismiss: vi.fn(),
    // The record is what crucible_runs reads, so the stub moves it the way
    // the engine does rather than only counting the call.
    adopt: vi.fn((runId: string, sessionId: string) => {
      const at = runs.findIndex((run) => run.id === runId)
      if (at >= 0) runs[at] = { ...runs[at], sessionId }
    }),
    answer: vi.fn(),
    nodeTranscript: (): readonly TranscriptItem[] => [{ kind: 'assistant', markdown: 'hi' }],
    dispose: vi.fn()
  }
}

const loader: WorkflowLoader = {
  async list(): Promise<LoadedWorkflow[]> {
    return [
      {
        name: 'adhoc',
        origin: 'built-in',
        path: '/x/adhoc.ts',
        def: {
          description: 'one node running a prompt file',
          inputs: { prompt: 'a task file' },
          run: async () => {}
        }
      }
    ]
  },
  async resolve(): Promise<LoadedWorkflow> {
    throw new Error('not under test')
  }
}

function serviceOver(runs: RunRecord[], subscribers: Array<() => void> = []) {
  const engine = engineOf(runs)
  const service = createLiveWorkflowRunService({
    engine,
    loader,
    changes: { subscribe: (listener) => subscribers.push(listener) }
  })
  return { engine, service }
}

describe('the live run service', () => {
  it('lists the catalog with origins and inputs for the agent', async () => {
    const { service } = serviceOver([])
    const text = await service.tools.workflows('/repos/thing')
    expect(text).toContain('adhoc (built-in) — one node running a prompt file')
    expect(text).toContain('prompt: a task file')
  })

  it("describes this session's runs and flags a waiting question", async () => {
    const waiting = record({
      id: 'cd34',
      waiting: true,
      question: { reason: 'which way?', raisedAt: '2026-08-20T10:05:00.000Z' }
    })
    const foreign = record({ id: 'zz99', sessionId: 'someone-else' })
    const { service } = serviceOver([waiting, foreign])

    const text = await service.tools.list('s1')
    expect(text).toContain('cd34')
    expect(text).toContain('⚑ waiting on an answer: which way?')
    expect(text).not.toContain('zz99')
  })

  it('carries Dismiss and Investigate’s adoption through to the engine', async () => {
    const { engine, service } = serviceOver([record({})])
    await service.dismiss('ab12')
    expect(engine.dismiss).toHaveBeenCalledWith('ab12')
    await service.adopt('ab12', 's7')
    expect(engine.adopt).toHaveBeenCalledWith('ab12', 's7')
  })

  it('lists an adopted run for its new session and stops listing it for the old', async () => {
    const { service } = serviceOver([record({ id: 'cd34' })])

    expect(await service.tools.list('s1')).toContain('cd34')
    await service.adopt('cd34', 'investigator-9')

    expect(await service.tools.list('investigator-9')).toContain('cd34')
    expect(await service.tools.list('s1')).toBe('This session has no workflow runs.')
  })

  it('says so when the session has no runs', async () => {
    const { service } = serviceOver([])
    expect(await service.tools.list('s1')).toBe('This session has no workflow runs.')
  })

  it('routes an answer to the engine and confirms it to the model', async () => {
    const { engine, service } = serviceOver([record({})])
    const said = await service.tools.answer('s1', 'ab12', 'go left')
    expect(engine.answer).toHaveBeenCalledWith('ab12', 'go left')
    expect(said).toContain('ab12')
  })

  it('coalesces a burst of engine changes into one runs event', async () => {
    vi.useFakeTimers()
    try {
      const subscribers: Array<() => void> = []
      const { service } = serviceOver([record({})], subscribers)
      const events: WorkflowRunEvent[] = []
      service.onEvent((event) => events.push(event))

      for (let burst = 0; burst < 20; burst += 1) subscribers[0]()
      expect(events).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(200)
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('runs')
    } finally {
      vi.useRealTimers()
    }
  })

  it('announces toggle-overview to whoever listens', () => {
    const { service } = serviceOver([])
    const events: WorkflowRunEvent[] = []
    service.onEvent((event) => events.push(event))
    service.toggleOverview()
    expect(events).toEqual([{ type: 'toggle-overview' }])
  })
})
