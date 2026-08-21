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

    // One canned record carries a failed node with its reason, so the failed
    // card and the walked edge into it are visible without staging anything.
    const failed = (unattended?.nodes ?? []).find((node) => node.status === 'failed')
    expect(failed?.error).toBeDefined()
    expect(failed?.parents).toEqual(['planner'])
    service.dispose()
  })

  // The graph is only checkable under the fake flavor if the fake draws a
  // graph worth checking: a fan-out, a fan-in, a send-back and edges nobody
  // has walked yet.
  it('scripts a build run with a shape the graph can be read against', async () => {
    const service = createFakeWorkflowRunService({ beatMs: 0 })
    await service.tools.start('s1', '/repos/thing', 'build', { intent: '/repos/thing/i.md' })
    const run = (await service.snapshot()).runs.find((candidate) => candidate.sessionId === 's1')
    const nodes = run?.nodes ?? []
    const parentsOf = (id: string): readonly string[] =>
      nodes.find((node) => node.id === id)?.parents ?? []

    // Every node stands as a ghost at kickoff, so the planned edges are drawn
    // dashed before the walk reaches them.
    expect(nodes.length).toBeGreaterThan(3)
    expect(nodes.filter((node) => node.status === 'pending').length).toBeGreaterThan(1)

    // A fan-out: two nodes naming one parent.
    const fannedOut = nodes.filter((node) => node.parents.includes('builder'))
    expect(fannedOut.map((node) => node.id)).toEqual(['review-1', 'review-tests'])
    // A fan-in: one node naming two parents.
    expect(parentsOf('fixer-1')).toEqual(['review-1', 'review-tests'])
    // A send-back, with a real revision id and a reviewer among its parents.
    expect(parentsOf('review-1·r1')).toEqual(['fixer-1', 'review-tests'])

    // Every parent names a node the record holds: nothing draws to nothing.
    const ids = new Set(nodes.map((node) => node.id))
    for (const node of nodes) {
      for (const parent of node.parents) expect(ids.has(parent), parent).toBe(true)
    }
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
    // The names tests already knew are where they were; the nodes the script
    // grew extend the list rather than renaming anything.
    expect(
      done?.nodes.map((node) => node.artifacts.map((one) => one.path.split('/').at(-1)))
    ).toEqual([
      ['spec.md'],
      ['changes.md'],
      ['review.md'],
      ['review-tests.md'],
      ['fixes.md'],
      ['review.md']
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
