// @vitest-environment node
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptItem } from '../../shared/agent/port'
import { resumeRefusal, type RunRecord } from '../../shared/workflows/run'
import type { WorkflowRunEvent } from '../../shared/workflows/service'
import type { StartRunRequest, WorkflowEngine } from './engine'
import type { LoadedWorkflow, WorkflowLoader } from './loader'
import { createLiveWorkflowRunService } from './service'
import type { TargetRepository } from './target'
import { cleanupScratch, git, tempDir, tempRepo } from './testing/engine-rig'

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

interface EngineStub {
  // Where the stub says the run's target repository settled, which is the
  // engine's call and not the service's; the workspace's own by default.
  readonly settle?: (request: StartRunRequest) => TargetRepository
  /** What the record the stub hands back says beyond its defaults. */
  readonly startedAs?: Partial<RunRecord>
}

function engineOf(
  runs: RunRecord[],
  stub: EngineStub = {}
): WorkflowEngine & { started: StartRunRequest[]; bases: string[] } {
  const started: StartRunRequest[] = []
  const bases: string[] = []
  const settle = stub.settle ?? ((request) => ({ path: request.workspacePath }))
  return {
    started,
    bases,
    runs: () => runs,
    // The base is asked for the way the engine asks: once the target is
    // settled, before anything is made.
    async start(request) {
      started.push(request)
      bases.push(
        typeof request.base === 'string' ? request.base : await request.base(settle(request))
      )
      return record({ id: 'new1', ...stub.startedAs })
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
      },
      {
        name: 'create-change',
        origin: 'workspace',
        path: '/x/create-change.ts',
        manifest: {
          description: 'write a change into whichever repository it is for',
          inputs: {},
          target: { required: true },
          plans: false
        },
        open: () => {
          throw new Error('not under test')
        }
      },
      {
        name: 'wiki-lint',
        origin: 'workspace',
        path: '/x/wiki-lint.ts',
        manifest: {
          description: 'lint the component wiki',
          inputs: {},
          target: 'components/wiki',
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
  base?: (repositoryPath: string) => Promise<string>,
  stub: EngineStub = {}
) {
  const engine = engineOf(runs, stub)
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

  // An orchestrator learns what a workflow needs of its target before it
  // starts one, rather than from a refusal.
  it('lists what target a workflow requires or fixes, and nothing for one that declares none', async () => {
    const { service } = serviceOver([])
    const text = await service.tools.workflows('/repos/thing')
    expect(text).toContain(
      "- create-change (workspace) — write a change into whichever repository it is for\n" +
        "  target: required — name a repository inside the workspace with crucible_run's `target`"
    )
    expect(text).toContain(
      '- wiki-lint (workspace) — lint the component wiki\n' +
        '  target: components/wiki — fixed; name it or no target at all'
    )
    expect(text).toContain('adhoc (workspace) — one node running a prompt file\n  inputs: prompt: a task file\n- ')
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
        base: expect.any(Function),
        scheduled: true
      }
    ])
    expect(engine.bases).toEqual(['refs/remotes/origin/main'])
    expect(run.id).toBe('new1')
  })

  // A workflow that fixes its target is the only kind a schedule can land in
  // another repository, and the trunk it branches from is that repository's.
  it('fetches the trunk of the target repository a scheduled workflow fixes', async () => {
    const asked: string[] = []
    const { engine, service } = serviceOver(
      [],
      [],
      async (repositoryPath) => {
        asked.push(repositoryPath)
        return 'refs/remotes/origin/main'
      },
      { settle: () => ({ named: 'components/app', path: '/repos/thing/components/app' }) }
    )

    await service.startScheduled({ workspacePath: '/repos/thing', workflow: 'triage' })

    expect(asked).toEqual(['/repos/thing/components/app'])
    expect(engine.started[0].workspacePath).toBe('/repos/thing')
  })

  it('refuses a scheduled fire whose trunk cannot be resolved', async () => {
    const { engine, service } = serviceOver([], [], async () => {
      throw new Error('no origin/HEAD, main or master')
    })

    await expect(
      service.startScheduled({ workspacePath: '/repos/thing', workflow: 'triage' })
    ).rejects.toThrow(/no origin\/HEAD/)
    // Nothing was started: the failure is the schedule's, before a run exists.
    expect(engine.bases).toEqual([])
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

  it('resumes through the tool, naming the run, the stopped node and the worktree', async () => {
    const { engine, service } = serviceOver([
      record({
        id: 'cd34',
        status: 'interrupted',
        worktreePath: '/repos/thing/.crucible/worktrees/run-cd34',
        nodes: [
          {
            id: 'gate',
            status: 'interrupted',
            parents: [],
            reads: [],
            artifacts: [],
            sessionToken: '/state/workflow-runs/cd34/sessions/1.jsonl'
          }
        ]
      })
    ])

    const said = await service.tools.resume('s1', 'cd34')

    expect(engine.resume).toHaveBeenCalledWith('cd34', undefined)
    expect(said).toContain('cd34')
    expect(said).toContain('"gate"')
    expect(said).toContain('continues from its last turn')
    expect(said).toContain('/repos/thing/.crucible/worktrees/run-cd34')
    expect(said).toContain('reports back here')
  })

  it('restarts a node cleanly when the tool is asked for that instead', async () => {
    const { engine, service } = serviceOver([
      record({
        id: 'cd34',
        status: 'interrupted',
        worktreePath: '/repos/thing/.crucible/worktrees/run-cd34',
        nodes: [
          {
            id: 'gate',
            status: 'interrupted',
            parents: [],
            reads: [],
            artifacts: [],
            sessionToken: '/state/workflow-runs/cd34/sessions/1.jsonl'
          }
        ]
      })
    ])

    const said = await service.tools.resume('s1', 'cd34', 'clean-restart')

    expect(engine.resume).toHaveBeenCalledWith('cd34', 'clean-restart')
    expect(said).toContain('runs again from its prompt')
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

  describe('starting a run', () => {
    afterEach(cleanupScratch)

    it("branches an untargeted run from the session's own HEAD and names no repository", async () => {
      const workspace = tempRepo()
      const { engine, service } = serviceOver([], [], undefined, {
        startedAs: { worktreePath: `${workspace}/.crucible/worktrees/run-new1`, baseCommit: 'abcdef1234' }
      })

      const said = await service.tools.start('s1', workspace, 'adhoc', {})

      expect(engine.started[0]).not.toHaveProperty('target')
      expect(engine.bases).toEqual([git(workspace, 'rev-parse', 'HEAD')])
      expect(said).toBe(
        `Run new1 of "adhoc" started · branch crucible/run-ab12 · worktree ${workspace}/.crucible/` +
          'worktrees/run-new1 · base abcdef1.\nIt works unattended and reports back to this session — ' +
          'check-ins, blockers and completion all arrive here as messages. Ending your turn now is the ' +
          'normal thing to do.'
      )
    })

    it("hands the engine the target as named, and branches from the target's HEAD", async () => {
      const workspace = tempRepo()
      const component = tempRepo()
      writeFileSync(join(component, 'more.txt'), 'more\n')
      git(component, 'add', '-A')
      git(component, 'commit', '-q', '-m', 'second')
      const { engine, service } = serviceOver([], [], undefined, {
        settle: () => ({ named: 'app', path: component }),
        startedAs: { targetRepository: 'app' }
      })

      const said = await service.tools.start('s1', workspace, 'adhoc', {}, { target: ' app ' })

      expect(engine.started[0].target).toBe('app')
      expect(engine.bases).toEqual([git(component, 'rev-parse', 'HEAD')])
      expect(engine.bases[0]).not.toBe(git(workspace, 'rev-parse', 'HEAD'))
      expect(said).toContain('started · repository app · branch crucible/run-ab12 · ')
    })

    it('leaves a named base to be resolved in the target, untouched', async () => {
      const workspace = tempRepo()
      const { engine, service } = serviceOver([], [], undefined, {
        settle: () => ({ named: 'app', path: join(workspace, 'app') })
      })

      await service.tools.start('s1', workspace, 'adhoc', {}, { target: 'app', base: ' main ' })

      expect(engine.bases).toEqual(['main'])
    })

    it('refuses an untargeted run in a workspace folder that is no repository, and starts a targeted one', async () => {
      const folder = tempDir('crucible-not-a-repo-')
      const component = tempRepo()
      const { engine, service } = serviceOver([], [], undefined, {
        settle: (request) =>
          request.target === undefined ? { path: request.workspacePath } : { named: 'app', path: component }
      })

      await expect(service.tools.start('s1', folder, 'adhoc', {})).rejects.toThrow(
        `${folder} is not inside a git repository, so a run has no commit to branch from.`
      )

      await service.tools.start('s1', folder, 'adhoc', {}, { target: 'app' })
      expect(engine.started[1].workspacePath).toBe(folder)
      expect(engine.bases).toEqual([git(component, 'rev-parse', 'HEAD')])
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
