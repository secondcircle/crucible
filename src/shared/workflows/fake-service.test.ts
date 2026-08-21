// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { runIsLive } from './run'
import { createFakeWorkflowRunService } from './fake-service'

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
