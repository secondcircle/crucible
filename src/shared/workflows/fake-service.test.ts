// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { runIsLive, type RunRecord } from './run'
import type { MainWorkflowRunService } from './service'
import { createFakeWorkflowRunService, memoryArtifactFiles } from './fake-service'

async function until(what: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms
  while (!what()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('the fake workflow run service', () => {
  it('seeds the global view: one finished run, one unattended parked run', async () => {
    const service = createFakeWorkflowRunService({ beatMs: 0 })
    const { runs } = await service.snapshot()
    expect(runs.some((run) => run.status === 'complete')).toBe(true)
    const unattended = runs.find((run) => run.sessionId === undefined && runIsLive(run))
    expect(unattended?.waiting).toBe(true)
    service.dispose()
  })

  // The screenshot state, shipped: a failed run whose orchestrator session is
  // gone, so the row has no Go to session and nothing that can end it.
  it('seeds a failed run whose session no longer exists, and dismissing it re-bands the row', async () => {
    const service = createFakeWorkflowRunService({ beatMs: 0 })
    const failed = (await service.snapshot()).runs.find((run) => run.id === 'b1n7')

    expect(failed?.status).toBe('failed')
    expect(failed?.workflow).toBe('build')
    expect(failed?.sessionId).toBeDefined()
    expect(failed?.error).toBeDefined()
    // Ended hours ago, so the row reads as the stale thing it is.
    expect(Date.now() - Date.parse(failed?.endedAt ?? '')).toBeGreaterThan(3_600_000)
    expect(failed?.dismissedAt).toBeUndefined()

    // The stamp is the whole of what moves the row out of Needs you; that
    // banding is proved over bandOf itself in the renderer's band tests.
    await service.dismiss('b1n7')
    const cleared = (await service.snapshot()).runs.find((run) => run.id === 'b1n7')
    expect(cleared?.dismissedAt).toBeDefined()
    // Only where it sits changed: the record is otherwise the same run.
    expect(cleared?.status).toBe('failed')
    expect(cleared?.branch).toBe(failed?.branch)
    expect(cleared?.nodes).toHaveLength(failed?.nodes.length ?? 0)

    // Dismissing twice says nothing new, and a live run is refused outright.
    await service.dismiss('b1n7')
    expect(
      (await service.snapshot()).runs.find((run) => run.id === 'b1n7')?.dismissedAt
    ).toBe(cleared?.dismissedAt)
    await expect(service.dismiss('g8x2')).rejects.toThrow(/still working/)
    service.dispose()
  })

  // The unstick demo end to end: the parked run has nobody to ask until a
  // session adopts it, and then the answer walks it home.
  it('resumes the canned parked run once a session has adopted it', async () => {
    const delivered: { sessionId: string; text: string }[] = []
    const service = createFakeWorkflowRunService({
      beatMs: 0,
      deliver: (sessionId, text) => delivered.push({ sessionId, text })
    })

    const parked = (await service.snapshot()).runs.find((run) => run.id === 'g8x2')
    expect(parked?.sessionId).toBeUndefined()
    expect(parked?.waiting).toBe(true)

    await service.adopt('g8x2', 'investigator-9')
    expect((await service.snapshot()).runs.find((run) => run.id === 'g8x2')?.sessionId).toBe(
      'investigator-9'
    )

    await service.tools.answer('investigator-9', 'g8x2', 'put the helper in the merge module')
    await until(() => delivered.some((message) => message.text.includes('completed')))

    const done = (await service.snapshot()).runs.find((run) => run.id === 'g8x2')
    expect(done?.status).toBe('complete')
    expect(done?.waiting).toBe(false)
    expect(done?.question?.answer).toBe('put the helper in the merge module')
    expect(done?.nodes.every((node) => node.status === 'complete')).toBe(true)
    // The completion reached the session that adopted it, and no other.
    expect(delivered.every((message) => message.sessionId === 'investigator-9')).toBe(true)
    service.dispose()
  })

  // Investigate makes a session in the run's own workspace, so a canned run
  // in a workspace nobody can open is a row whose Investigate never acts. The
  // launch hands in a directory that exists; every canned record takes it.
  it('puts its canned records in the workspace it was given', async () => {
    const service = createFakeWorkflowRunService({
      beatMs: 0,
      workspace: { path: '/repos/crucible', name: 'crucible' }
    })

    const { runs } = await service.snapshot()
    const canned = runs.filter((run) => ['g8x2', 'b1n7', 'd3p8'].includes(run.id))
    expect(canned).toHaveLength(3)
    for (const run of canned) {
      expect(run.workspacePath, run.id).toBe('/repos/crucible')
      expect(run.workspaceName, run.id).toBe('crucible')
      // The rest of the run's story follows the same workspace: a worktree
      // somewhere else would read as another repo's run.
      expect(run.worktreePath, run.id).toBe(`/repos/crucible/.crucible/worktrees/run-${run.id}`)
      expect(Object.values(run.inputs).join(' '), run.id).toContain('/repos/crucible/')
    }
    service.dispose()
  })

  it('carries the run directory on every record it hands out', async () => {
    const files = memoryArtifactFiles()
    const service = createFakeWorkflowRunService({ beatMs: 0, files })

    for (const run of (await service.snapshot()).runs) {
      expect(run.dir, run.id).toBe(files.dir(run.id).replace(/\/artifacts$/, ''))
    }

    await service.tools.start('s1', '/repos/thing', 'adhoc', {})
    const started = (await service.snapshot()).runs.find((run) => run.sessionId === 's1')
    expect(started?.dir).toBe(files.dir(started?.id ?? '').replace(/\/artifacts$/, ''))
    service.dispose()
  })

  it('walks a scripted adhoc run to completion and tells the orchestrator', async () => {
    const delivered: { sessionId: string; text: string }[] = []
    const service = createFakeWorkflowRunService({
      beatMs: 0,
      deliver: (sessionId, text) => delivered.push({ sessionId, text })
    })

    const said = await service.tools.start('s1', '/repos/thing', 'adhoc', {})
    expect(said).toContain('started')

    await until(() =>
      delivered.some((message) => message.text.includes('completed'))
    )
    const { runs } = await service.snapshot()
    const run = runs.find((candidate) => candidate.sessionId === 's1')
    expect(run?.status).toBe('complete')
    expect(run?.nodes.every((node) => node.status === 'complete')).toBe(true)
    expect(delivered[0].sessionId).toBe('s1')
    service.dispose()
  })

  it('parks the build script at a check-in and resumes on crucible_answer', async () => {
    const delivered: string[] = []
    const service = createFakeWorkflowRunService({
      beatMs: 0,
      deliver: (_sessionId, text) => delivered.push(text)
    })

    await service.tools.start('s1', '/repos/thing', 'build', {})
    await until(() => delivered.some((text) => text.includes('checking in')))

    const { runs } = await service.snapshot()
    const run = runs.find((candidate) => candidate.sessionId === 's1')
    expect(run?.waiting).toBe(true)

    const runId = run?.id ?? ''
    await service.tools.answer('s1', runId, 'proceed')
    await until(() => delivered.some((text) => text.includes('completed')))

    const after = (await service.snapshot()).runs.find((candidate) => candidate.id === runId)
    expect(after?.status).toBe('complete')
    expect(after?.question?.answer).toBe('proceed')
    service.dispose()
  })

  it('cancel ends a scripted run where it stands', async () => {
    const service = createFakeWorkflowRunService({ beatMs: 50 })
    await service.tools.start('s1', '/repos/thing', 'adhoc', {})
    const started = (await service.snapshot()).runs.find(
      (candidate) => candidate.sessionId === 's1'
    )
    await service.cancel(started?.id ?? '')
    const after = (await service.snapshot()).runs.find(
      (candidate) => candidate.id === started?.id
    )
    expect(after?.status).toBe('cancelled')
    service.dispose()
  })
})

// The rail is only visible in the fake flavor because scripted nodes declare
// artifacts and then write them; this is that, at the seam main hands in.
describe('the fake flavor\u2019s artifacts', () => {
  /** The latest record of one run, as the run surfaces would see it. */
  function watch(service: MainWorkflowRunService): (runId: string) => RunRecord | undefined {
    let runs: readonly RunRecord[] = []
    service.onEvent((event) => {
      if (event.type === 'runs') runs = event.snapshot.runs
    })
    return (runId) => runs.find((run) => run.id === runId)
  }

  it('declares a node\u2019s outputs when it starts and writes them when it completes', async () => {
    const files = memoryArtifactFiles()
    const service = createFakeWorkflowRunService({ beatMs: 20, files })
    const latest = watch(service)

    await service.tools.start('s1', '/repos/thing', 'build', {
      intent: '/repos/thing/docs/intent/rail.md'
    })
    const started = (await service.snapshot()).runs.find((run) => run.sessionId === 's1')
    const runId = started?.id ?? ''
    const planner = started?.nodes[0]

    // Declared, named and unwritten, with nothing on disk yet.
    expect(planner?.status).toBe('running')
    expect(planner?.artifacts.map((artifact) => artifact.name)).toEqual(['spec'])
    expect(planner?.artifacts[0].writtenAt).toBeUndefined()
    expect(planner?.artifacts[0].path).toBe(`${files.dir(runId)}/spec.md`)
    expect(files.written.has(planner?.artifacts[0].path ?? '')).toBe(false)
    // The kickoff input is on the record, described, and read by the planner.
    expect(started?.inputDescs?.intent).toBeDefined()
    expect(planner?.reads.map((read) => read.path)).toEqual(['/repos/thing/docs/intent/rail.md'])

    await until(() => latest(runId)?.nodes[0].artifacts[0].writtenAt !== undefined)
    const written = latest(runId)?.nodes[0].artifacts[0]
    expect(files.written.get(written?.path ?? '')).toContain('#')

    // The chain: each node reads what the one before it wrote.
    await until(() => latest(runId)?.waiting === true)
    await service.tools.answer('s1', runId, 'carry on')
    await until(() => latest(runId)?.status === 'complete')
    const done = latest(runId)
    expect(done?.nodes.map((node) => node.artifacts.map((one) => one.name))).toEqual([
      ['spec'],
      ['changes'],
      ['review']
    ])
    expect(done?.nodes[1].reads.map((read) => read.name)).toEqual(['rail.md', 'spec.md'])
    expect(done?.nodes[2].reads.map((read) => read.name)).toEqual(['spec.md', 'changes.md'])
    expect(done?.nodes.every((node) => node.artifacts[0].writtenAt !== undefined)).toBe(true)
    service.dispose()
  })

  it('writes the canned runs\u2019 artifacts at construction, and reads them back through the gate', async () => {
    const files = memoryArtifactFiles()
    const service = createFakeWorkflowRunService({ beatMs: 0, files })

    const finished = (await service.snapshot()).runs.find((run) => run.id === 'd3p8')
    const written = (finished?.nodes ?? []).flatMap((node) => node.artifacts)
    expect(written.length).toBeGreaterThan(0)
    for (const artifact of written) {
      expect(files.written.has(artifact.path), artifact.path).toBe(true)
    }
    // One of them is HTML, so the exhibit-run route is exercisable in dev.
    const report = written.find((artifact) => artifact.path.endsWith('.html'))
    expect(report).toBeDefined()
    expect(service.artifactFile('d3p8', report?.path ?? '')).toEqual({ path: report?.path })

    const view = await service.artifact('d3p8', `${files.dir('d3p8')}/spec.md`)
    expect(view.kind).toBe('markdown')
    expect(view.body).toContain('#')
    expect(view.bytes).toBeGreaterThan(0)
    // HTML never enters the renderer as a string; it rides the frame.
    expect((await service.artifact('d3p8', report?.path ?? '')).body).toBeUndefined()

    // A path the record does not name is refused, whatever it points at.
    await expect(service.artifact('d3p8', '/etc/passwd')).rejects.toThrow(/not one this run/)
    await expect(
      service.artifact('d3p8', `${files.dir('d3p8')}/../../secrets.md`)
    ).rejects.toThrow(/not one this run/)
    expect(service.artifactFile('d3p8', '/etc/passwd')).toBeUndefined()
    service.dispose()
  })

  it('keeps a parked run\u2019s expected artifact unwritten, so the rail has that state too', async () => {
    const service = createFakeWorkflowRunService({ beatMs: 0, files: memoryArtifactFiles() })
    const parked = (await service.snapshot()).runs.find((run) => run.id === 'g8x2')

    expect(parked?.nodes[0].artifacts[0].writtenAt).toBeDefined()
    expect(parked?.nodes[1].status).toBe('blocked')
    expect(parked?.nodes[1].artifacts[0].writtenAt).toBeUndefined()
    service.dispose()
  })
})
