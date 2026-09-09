// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { TranscriptItem } from '../../shared/agent/port'
import { resumeRefusal, type RunRecord } from '../../shared/workflows/run'
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
    // The record moves the way the engine moves it, so what the tool answers
    // and what the next listing says are read off one state.
    resume: vi.fn(async (runId: string) => {
      const at = runs.findIndex((run) => run.id === runId)
      if (at < 0) throw new Error(`No run is named "${runId}".`)
      if (runs[at].status !== 'interrupted' && runs[at].status !== 'paused') {
        throw new Error(resumeRefusal(runId, runs[at].status))
      }
      runs[at] = {
        ...runs[at],
        status: 'running',
        nodes: runs[at].nodes.map((node) =>
          node.status === 'interrupted' ? { ...node, status: 'pending' } : node
        )
      }
    }),
    cancel: vi.fn(),
    dismiss: vi.fn(),
    deliverNotices: vi.fn(),
    // The record is what crucible_runs reads, so the stub moves it the way
    // the engine does rather than only counting the call.
    adopt: vi.fn((runId: string, sessionId: string) => {
      const at = runs.findIndex((run) => run.id === runId)
      if (at >= 0) runs[at] = { ...runs[at], sessionId }
    }),
    answer: vi.fn(),
    nodeTranscript: async (): Promise<readonly TranscriptItem[]> => [
      { kind: 'assistant', markdown: 'hi' }
    ],
    dispose: vi.fn()
  }
}

const loader: WorkflowLoader = {
  async list(): Promise<LoadedWorkflow[]> {
    return [
      {
        name: 'adhoc',
        origin: 'workspace',
        path: '/x/adhoc.ts',
        manifest: {
          description: 'one node running a prompt file',
          inputs: { prompt: 'a task file' },
          plans: false
        },
        open: () => {
          throw new Error('not under test')
        }
      }
    ]
  },
  async resolve(): Promise<LoadedWorkflow> {
    throw new Error('not under test')
  }
}

function serviceOver(
  runs: RunRecord[],
  subscribers: Array<() => void> = [],
  base?: (workspacePath: string) => Promise<string>
) {
  const engine = engineOf(runs)
  const service = createLiveWorkflowRunService({
    engine,
    loader,
    changes: { subscribe: (listener) => subscribers.push(listener) },
    ...(base === undefined ? {} : { base })
  })
  return { engine, service }
}

describe('the live run service', () => {
  it('lists the catalog with origins and inputs for the agent', async () => {
    const { service } = serviceOver([])
    const text = await service.tools.workflows('/repos/thing')
    expect(text).toContain('adhoc (workspace) — one node running a prompt file')
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

  // A scheduled fire is an ordinary run with three things settled for it: the
  // trunk to branch from, nothing handed in, and nobody to report to.
  it('fires a scheduled run from the trunk, with no session and no inputs', async () => {
    const asked: string[] = []
    const { engine, service } = serviceOver([], [], async (workspacePath) => {
      asked.push(workspacePath)
      return 'refs/remotes/origin/main'
    })

    const run = await service.startScheduled({
      workspacePath: '/repos/thing',
      workflow: 'triage'
    })

    expect(asked).toEqual(['/repos/thing'])
    expect(engine.started).toEqual([
      {
        workspacePath: '/repos/thing',
        workspaceName: 'thing',
        workflow: 'triage',
        inputs: {},
        base: 'refs/remotes/origin/main',
        scheduled: true
      }
    ])
    expect(run.id).toBe('new1')
  })

  it('refuses a scheduled fire whose trunk cannot be resolved', async () => {
    const { engine, service } = serviceOver([], [], async () => {
      throw new Error('no origin/HEAD, main or master')
    })

    await expect(
      service.startScheduled({ workspacePath: '/repos/thing', workflow: 'triage' })
    ).rejects.toThrow(/no origin\/HEAD/)
    // Nothing was started: the failure is the schedule's, before a run exists.
    expect(engine.started).toEqual([])
  })

  // An interrupted run reads as what happened and what to do about it: the
  // status, why it stopped, and the lever.
  it('says a run is interrupted by an app quit and names the tool that resumes it', async () => {
    const { service } = serviceOver([
      record({
        id: 'cd34',
        status: 'interrupted',
        error: 'Crucible quit while this run was working, so it stopped where it stood.',
        nodes: [
          { id: 'gate', status: 'interrupted', parents: [], reads: [], artifacts: [], cost: 3.62 }
        ],
        endedAt: '2026-08-20T10:40:00.000Z'
      })
    ])

    const text = await service.tools.list('s1')
    expect(text).toContain('interrupted \u00b7 app quit')
    expect(text).toContain('node gate interrupted')
    expect(text).toContain('resume with crucible_resume if this work is still wanted')
  })

  it('resumes through the tool, naming the run, the cut node and the worktree', async () => {
    const { engine, service } = serviceOver([
      record({
        id: 'cd34',
        status: 'interrupted',
        worktreePath: '/repos/thing/.crucible/worktrees/run-cd34',
        nodes: [{ id: 'gate', status: 'interrupted', parents: [], reads: [], artifacts: [] }]
      })
    ])

    const said = await service.tools.resume('s1', 'cd34')

    expect(engine.resume).toHaveBeenCalledWith('cd34')
    expect(said).toContain('cd34')
    expect(said).toContain('"gate"')
    expect(said).toContain('/repos/thing/.crucible/worktrees/run-cd34')
    expect(said).toContain('reports back here')
  })

  it('throws the refusal a model should read when there is nothing to resume', async () => {
    const { service } = serviceOver([record({ id: 'cd34', status: 'complete' })])
    await expect(service.tools.resume('s1', 'cd34')).rejects.toThrow(
      'The run "cd34" is complete; there is nothing to resume.'
    )
    await expect(service.tools.resume('s1', 'nope')).rejects.toThrow('No run is named "nope".')
  })

  describe('the turn-start hook', () => {
    it('injects the changed runs of this session, once per change, invisibly', async () => {
      const runs = [record({ id: 'cd34' }), record({ id: 'zz99', sessionId: 'someone-else' })]
      const { engine, service } = serviceOver(runs)

      // The first turn after a launch knows nothing, so everything this
      // session orchestrates is said.
      const first = service.turnStart('s1')
      expect(first).toContain('Crucible status update')
      expect(first).toContain('cd34')
      expect(first).not.toContain('zz99')
      expect(engine.deliverNotices).toHaveBeenCalledWith('s1')

      // A quiet turn costs nothing at all.
      expect(service.turnStart('s1')).toBeUndefined()

      // The node moved, so the next turn hears about it, and only about that.
      runs[0] = {
        ...runs[0],
        nodes: [{ ...runs[0].nodes[0], status: 'complete' }]
      }
      const second = service.turnStart('s1')
      expect(second).toContain('cd34')
      expect(service.turnStart('s1')).toBeUndefined()
    })

    it('says nothing at all for a session that orchestrates no runs', () => {
      const { engine, service } = serviceOver([record({ sessionId: 'someone-else' })])
      expect(service.turnStart('s1')).toBeUndefined()
      // Woken all the same: a session with no runs is owed nothing, and asking
      // is how that is found out.
      expect(engine.deliverNotices).toHaveBeenCalledWith('s1')
    })

    it('keeps one picture per session, so two sessions are told separately', () => {
      const { service } = serviceOver([record({ id: 'cd34' }), record({ id: 'ef56', sessionId: 's2' })])
      expect(service.turnStart('s1')).toContain('cd34')
      expect(service.turnStart('s2')).toContain('ef56')
      expect(service.turnStart('s1')).toBeUndefined()
    })
  })

  it('announces toggle-overview to whoever listens', () => {
    const { service } = serviceOver([])
    const events: WorkflowRunEvent[] = []
    service.onEvent((event) => events.push(event))
    service.toggleOverview()
    expect(events).toEqual([{ type: 'toggle-overview' }])
  })
})
