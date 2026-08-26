// @vitest-environment node
//
// What the app quitting does to a run, and what resuming does about it. Every
// interruption here is the real thing: one engine leaves a record mid-flight,
// a second engine over the same store and the same repository sweeps it, and
// resume runs against the worktree the first one made. No SDK anywhere — node
// sessions are scripts, as everywhere else the engine is tested.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { INTERRUPTED_MESSAGE } from '../../shared/workflows/run'
import type { PlannedNode, WorkflowDef } from './authoring'
import { createWorkflowEngine } from './engine'
import { createRunStore } from './store'
import {
  cleanupScratch,
  git,
  loaderOf,
  outputPath,
  relaunch,
  rig,
  scriptedSessions,
  startRequest,
  tempDir,
  until,
  type NodeScript,
  type Rig
} from './testing/engine-rig'

afterEach(cleanupScratch)

// A planner and a gate. The gate blocks on its first turn, which is how a run
// is left mid-flight with one node done and one node holding a session.
const gated: WorkflowDef = {
  description: 'a planner and a gate',
  inputs: { intent: 'the intent document' },
  plan: (): PlannedNode[] => [
    { id: 'planner', outputs: { spec: { file: 'spec.md', desc: 'the Spec' } } },
    { id: 'gate', parents: ['planner'] }
  ],
  run: async (ctx) => {
    const planned = await ctx.node('planner', {
      prompt: 'write the spec',
      reads: [ctx.inputs.intent],
      outputs: { spec: { file: 'spec.md', desc: 'the Spec' } }
    })
    const gate = await ctx.node('gate', {
      prompt: 'judge the branch',
      reads: [planned.outputs.spec],
      outputs: { verdict: { file: 'verdict.md', desc: 'the verdict' } }
    })
    return { summary: gate.summary }
  }
}

/** Writes its spec and completes; blocks forever at the gate. */
const planThenPark: (nodeId: string) => NodeScript = (nodeId) => {
  if (nodeId === 'planner') {
    return (prompt, tools) => {
      writeFileSync(outputPath(prompt, 'spec.md'), 'the spec\n')
      tools.complete({ summary: 'wrote the spec' })
    }
  }
  return (_prompt, tools) => {
    // A line of liveness before it stops, which is what the record's honest
    // stop time is read from.
    tools.activity('reading the branch…')
    tools.block({ reason: 'which way?' })
  }
}

/**
 * A run left exactly as an app quit leaves one: planner complete, gate holding
 * a blocked session, the record on disk still saying `running`. The engine that
 * started it is abandoned rather than disposed, because a quit does not get to
 * tidy up either.
 */
async function interruptedRun(
  defs: Record<string, WorkflowDef> = { gated },
  script: (nodeId: string) => NodeScript = planThenPark
): Promise<{ before: Rig; runId: string }> {
  const before = rig(defs, script)
  const intent = join(before.repo, 'intent.md')
  writeFileSync(intent, 'the intent\n')
  const started = await before.engine.start(startRequest(before.repo, 'gated', { intent }))
  await until(() => before.engine.runs()[0].waiting === true)
  // Waited out rather than raced: the engine snapshots a node's activity on a
  // short debounce, and a quit landing mid-debounce is a different record from
  // the one these tests are about. A run parked on a workflow-level question
  // has no such node and nothing to wait for.
  const blocked = (): { cost?: number } | undefined =>
    before.engine.runs()[0].nodes.find((node) => node.status === 'blocked')
  if (blocked() !== undefined) await until(() => blocked()?.cost !== undefined)
  return { before, runId: started.id }
}

describe('the startup sweep', () => {
  it('lays a mid-flight run to rest as interrupted, honestly stamped, notice owed', async () => {
    const { before, runId } = await interruptedRun()
    const mid = before.engine.runs()[0]
    const lastSeen = mid.nodes[1].lastActivityAt

    const after = relaunch(before, { gated }, planThenPark)
    const run = after.engine.runs()[0]

    expect(run.id).toBe(runId)
    expect(run.status).toBe('interrupted')
    expect(run.error).toBe(INTERRUPTED_MESSAGE)
    // The stop time is the last thing a node was seen doing, not sweep time:
    // the app may have been shut for a week.
    expect(run.endedAt).toBe(lastSeen)
    // Nothing is owed an answer any more, and nothing claims to be thinking.
    expect(run.waiting).toBe(false)
    expect(run.question).toBeUndefined()
    expect(run.nodes.map((node) => node.status)).toEqual(['complete', 'interrupted'])
    expect(run.nodes[1].error).toBe(INTERRUPTED_MESSAGE)
    expect(run.nodes[1].endedAt).toBe(lastSeen)
    expect(run.nodes[1].now).toBeUndefined()
    // The orchestrator has not been told: no shell exists this early, so the
    // debt rides on the record.
    expect(run.noticePending).toBe(true)
    expect(after.delivered).toEqual([])
    // Written through, so the next launch reads the settled record.
    expect(createRunStore(after.stateDir).load()[0].status).toBe('interrupted')

    // A record, not a ghost: the live-only operations say so plainly.
    expect(() => after.engine.cancel(runId)).toThrow(/not live/)
  })

  it('owes no notice for a run with no orchestrator, and leaves a failed run failed', () => {
    const stateDir = tempDir('crucible-sweep-')
    const store = createRunStore(stateDir)
    store.save({
      id: 'aa11',
      workflow: 'solo',
      status: 'running',
      workspacePath: '/somewhere',
      workspaceName: 'somewhere',
      inputs: {},
      nodes: [{ id: 'work', status: 'running', parents: [], reads: [], artifacts: [] }],
      createdAt: '2026-01-01T00:00:00.000Z'
    })
    store.save({
      id: 'bb22',
      workflow: 'solo',
      status: 'failed',
      workspacePath: '/somewhere',
      workspaceName: 'somewhere',
      sessionId: 'orchestrator-1',
      error: 'the work went wrong',
      inputs: {},
      nodes: [{ id: 'work', status: 'failed', parents: [], reads: [], artifacts: [] }],
      createdAt: '2026-01-02T00:00:00.000Z'
    })

    const engine = createWorkflowEngine({
      loader: loaderOf({}),
      store,
      sessions: scriptedSessions(() => () => {}),
      deliver: () => {},
      onChanged: () => {}
    })

    const unattended = engine.runs().find((run) => run.id === 'aa11')
    expect(unattended?.status).toBe('interrupted')
    // No orchestrator, so nothing is owed a notice: the flag says a wake-up is
    // due, and there is nobody to wake.
    expect(unattended?.noticePending).toBeUndefined()
    // Sweep time is the fallback, and only when no node recorded anything.
    expect(unattended?.endedAt).toBeDefined()

    // A run past sweeps already stamped failed keeps what it says, error and
    // all: there is no retroactive relabelling.
    const past = engine.runs().find((run) => run.id === 'bb22')
    expect(past?.status).toBe('failed')
    expect(past?.error).toBe('the work went wrong')
    expect(past?.noticePending).toBeUndefined()
  })
})

describe('resume', () => {
  it('replays what completed, re-runs the cut node in the same worktree, and finishes', async () => {
    const { before, runId } = await interruptedRun()
    const worktree = before.engine.runs()[0].worktreePath ?? ''
    const branch = before.engine.runs()[0].branch ?? ''
    const plannerEnded = before.engine.runs()[0].nodes[0].endedAt

    const cwds: string[] = []
    const after = relaunch(before, { gated }, () => (prompt, tools) => {
      cwds.push(tools.cwd)
      writeFileSync(outputPath(prompt, 'verdict.md'), 'approved\n')
      writeFileSync(join(tools.cwd, 'gate-was-here.txt'), 'again\n')
      tools.complete({ summary: 'judged it', verdict: { verdict: 'approved' } })
    })

    await after.engine.resume(runId)
    await until(() => after.engine.runs()[0].status === 'complete')
    const run = after.engine.runs()[0]

    // Only the cut node opened a session; the planner was handed back from its
    // record, so nothing was spent on it.
    expect(after.sessions.prompts.map((prompt) => prompt.split(':')[0])).toEqual(['gate'])
    expect(cwds).toEqual([worktree])
    // From the node's own beginning: the first prompt is the composed task,
    // not a continuation of a conversation that no longer exists.
    expect(after.sessions.prompts[0]).toContain('judge the branch')

    // The planner's record is untouched, artifact and stamps and all.
    expect(run.nodes[0].status).toBe('complete')
    expect(run.nodes[0].endedAt).toBe(plannerEnded)
    expect(run.nodes[0].summary).toBe('wrote the spec')
    expect(readFileSync(run.nodes[0].artifacts[0].path, 'utf8')).toBe('the spec\n')

    // The same run, older: same id, same branch, same worktree, same base.
    expect(run.id).toBe(runId)
    expect(run.branch).toBe(branch)
    expect(run.worktreePath).toBe(worktree)
    expect(run.error).toBeUndefined()
    expect(run.nodes[1].status).toBe('complete')
    expect(run.nodes[1].verdict).toEqual({ verdict: 'approved' })
    expect(existsSync(join(worktree, 'gate-was-here.txt'))).toBe(true)

    // Its work is committed on its own branch, and the completion goes to the
    // orchestrator it always had.
    expect(run.finalCommit).toBe(git(before.repo, 'rev-parse', branch))
    const ending = after.delivered.at(-1)
    expect(ending?.sessionId).toBe('orchestrator-1')
    expect(ending?.text).toContain('completed')
    expect(ending?.text).toContain(branch)
  })

  it('keeps the money the cut node already burned and adds to it', async () => {
    const { before, runId } = await interruptedRun()
    const burned = before.engine.runs()[0].nodes[1].cost ?? 0
    expect(burned).toBeGreaterThan(0)


    const after = relaunch(before, { gated }, () => (prompt, tools) => {
      writeFileSync(outputPath(prompt, 'verdict.md'), 'approved\n')
      tools.complete({ summary: 'judged it' })
    })
    await after.engine.resume(runId)
    await until(() => after.engine.runs()[0].status === 'complete')

    expect(after.engine.runs()[0].nodes[1].cost).toBeGreaterThan(burned)
  })

  it('clears a dismissal, because a run that is working again must show', async () => {
    const { before, runId } = await interruptedRun()
    const after = relaunch(before, { gated }, () => (prompt, tools) => {
      writeFileSync(outputPath(prompt, 'verdict.md'), 'approved\n')
      tools.complete({ summary: 'judged it' })
    })

    // Dismissing an interrupted run stamps once and moves nothing else.
    after.engine.dismiss(runId)
    const stamped = after.engine.runs()[0].dismissedAt
    expect(stamped).toBeDefined()
    after.engine.dismiss(runId)
    expect(after.engine.runs()[0].dismissedAt).toBe(stamped)
    expect(after.engine.runs()[0].status).toBe('interrupted')

    await after.engine.resume(runId)
    expect(after.engine.runs()[0].dismissedAt).toBeUndefined()
    await until(() => after.engine.runs()[0].status === 'complete')
  })

  it('refuses every status that is not stopped, and a second resume racing the first', async () => {
    const { before, runId } = await interruptedRun()
    const after = relaunch(before, { gated }, () => async (prompt, tools) => {
      // Slow enough that the second resume lands while the first is working.
      await new Promise((resolve) => setTimeout(resolve, 40))
      writeFileSync(outputPath(prompt, 'verdict.md'), 'approved\n')
      tools.complete({ summary: 'judged it' })
    })

    const first = after.engine.resume(runId)
    await expect(after.engine.resume(runId)).rejects.toThrow(
      `The run "${runId}" is running; there is nothing to resume.`
    )
    await first
    await until(() => after.engine.runs()[0].status === 'complete')

    await expect(after.engine.resume(runId)).rejects.toThrow(
      `The run "${runId}" is complete; there is nothing to resume.`
    )
    await expect(after.engine.resume('nope')).rejects.toThrow(/No run is named/)
  })

  it('refuses a run whose worktree is gone, naming the path, before anything is spent', async () => {
    const { before, runId } = await interruptedRun()
    const worktree = before.engine.runs()[0].worktreePath ?? ''
    rmSync(worktree, { recursive: true, force: true })

    const after = relaunch(before, { gated }, () => () => {
      throw new Error('no node may run')
    })
    await expect(after.engine.resume(runId)).rejects.toThrow(worktree)
    expect(after.engine.runs()[0].status).toBe('interrupted')
    expect(after.sessions.prompts).toEqual([])
  })

  it('refuses with the loader’s own error when the workflow no longer resolves', async () => {
    const { before, runId } = await interruptedRun()
    // The workflow file is gone from this launch's ladder.
    const after = relaunch(before, {}, () => () => {})

    await expect(after.engine.resume(runId)).rejects.toThrow('No workflow is named "gated".')
    expect(after.engine.runs()[0].status).toBe('interrupted')
    expect(after.sessions.prompts).toEqual([])
  })

  it('goes unattended when the recorded orchestrator session is gone, and parks', async () => {
    const asking: WorkflowDef = {
      ...gated,
      run: async (ctx) => {
        await ctx.node('planner', {
          prompt: 'write the spec',
          reads: [ctx.inputs.intent],
          outputs: { spec: { file: 'spec.md', desc: 'the Spec' } }
        })
        await ctx.ask({ reason: 'ship it?' })
        return { summary: 'asked' }
      }
    }
    const { before, runId } = await interruptedRun({ gated: asking }, planThenPark)

    // Denying every session is what a removed sidebar entry looks like to
    // resume: the run's recorded orchestrator is not there any more.
    const denied = relaunch(
      before,
      { gated: asking },
      () => (prompt, tools) => {
        writeFileSync(outputPath(prompt, 'spec.md'), 'the spec\n')
        tools.complete({ summary: 'wrote the spec' })
      },
      { sessionExists: () => false }
    )

    await denied.engine.resume(runId)
    await until(() => denied.engine.runs()[0].waiting === true)
    const run = denied.engine.runs()[0]

    // No orchestrator, so no message went anywhere and the question parks the
    // run until a session adopts it (ADR 0023).
    expect(run.sessionId).toBeUndefined()
    expect(run.noticePending).toBeUndefined()
    expect(run.waiting).toBe(true)
    expect(denied.delivered).toEqual([])
  })

  it('asks a check-in for real on a resumed run rather than replaying an answer', async () => {
    const asking: WorkflowDef = {
      description: 'a planner, a question, a gate',
      inputs: { intent: 'the intent document' },
      plan: (): PlannedNode[] => [{ id: 'planner' }, { id: 'gate', parents: ['planner'] }],
      run: async (ctx) => {
        await ctx.node('planner', {
          prompt: 'write the spec',
          reads: [ctx.inputs.intent],
          outputs: { spec: { file: 'spec.md', desc: 'the Spec' } }
        })
        const said = await ctx.ask({ reason: 'ship it?' })
        const gate = await ctx.node('gate', { prompt: `judge it: ${said}` })
        return { summary: gate.summary }
      }
    }
    const { before, runId } = await interruptedRun({ gated: asking }, planThenPark)

    const after = relaunch(before, { gated: asking }, (nodeId) =>
      nodeId === 'planner'
        ? (prompt, tools) => {
            writeFileSync(outputPath(prompt, 'spec.md'), 'the spec\n')
            tools.complete({ summary: 'wrote the spec' })
          }
        : (_prompt, tools) => tools.complete({ summary: 'judged it' })
    )

    await after.engine.resume(runId)
    // The question is asked again, of the same orchestrator: only the latest
    // question is ever recorded, so replaying an answer would be a guess.
    await until(() => after.engine.runs()[0].waiting === true)
    expect(after.delivered.at(-1)?.text).toContain('ship it?')

    after.engine.answer(runId, 'ship it')
    await until(() => after.engine.runs()[0].status === 'complete')
    expect(after.sessions.prompts.some((prompt) => prompt.includes('judge it: ship it'))).toBe(
      true
    )
  })
})

describe('resume and held-open nodes', () => {
  // A reviewer held open across a fixer, which is the shape `revise()` exists
  // for: the review node completes, the workflow keeps its session, and later
  // feedback goes back into it.
  const reviewing: WorkflowDef = {
    description: 'a review held open, revised after a fixer',
    inputs: { intent: 'the intent document' },
    plan: (): PlannedNode[] => [{ id: 'review' }, { id: 'fixer', parents: ['review'] }],
    run: async (ctx) => {
      const review = await ctx.openNode('review', {
        prompt: 'review the branch',
        outputs: { review: { file: 'review.md', desc: 'the review' } }
      })
      await ctx.node('fixer', { prompt: 'fix what the review found' })
      const again = await review.revise('the fixer is done; look again', { from: ['fixer'] })
      review.close()
      return { summary: again.summary }
    }
  }

  it('revises a replayed node in a fresh session that is told what it is picking up', async () => {
    // The review completes and is held open; the fixer blocks, so the quit
    // catches the run with the review's session parked and complete.
    const before = rig({ gated: reviewing }, (nodeId) =>
      nodeId === 'review'
        ? (_prompt, tools) => {
            writeFileSync(outputPath(tools.taskPrompt, 'review.md'), 'changes required\n')
            tools.complete({ summary: 'reviewed once' })
          }
        : (_prompt, tools) => tools.block({ reason: 'which way?' })
    )
    const intent = join(before.repo, 'intent.md')
    writeFileSync(intent, 'the intent\n')
    const started = await before.engine.start(startRequest(before.repo, 'gated', { intent }))
    await until(() => before.engine.runs()[0].waiting === true)
    expect(before.engine.runs()[0].nodes[0].status).toBe('complete')

    const after = relaunch(before, { gated: reviewing }, (nodeId) =>
      nodeId === 'review'
        ? (_prompt, tools) => {
            writeFileSync(outputPath(tools.taskPrompt, 'review.md'), 'approved\n')
            tools.complete({ summary: 'reviewed again' })
          }
        : (_prompt, tools) => tools.complete({ summary: 'fixed it' })
    )

    await after.engine.resume(started.id)
    await until(() => after.engine.runs()[0].status === 'complete')
    const run = after.engine.runs()[0]

    // The completed review was replayed — no session for it — and the fixer,
    // which the quit cut down, re-ran.
    const revision = run.nodes.find((node) => node.id === 'review·r1')
    expect(revision?.status).toBe('complete')
    expect(revision?.summary).toBe('reviewed again')
    // The revision follows the record it revises and the reviewer that
    // triggered it, exactly as a first run writes those edges.
    expect(revision?.parents).toEqual(['review', 'fixer'])

    // Its session opened on the node's original task, was told the earlier
    // context is gone, and then heard the revision.
    const opening = after.sessions.prompts.find((prompt) => prompt.startsWith('review:'))
    expect(opening).toContain('review the branch')
    expect(run.outputs).toEqual({ summary: 'reviewed again' })
    const revised = after.sessions.prompts.filter((prompt) => prompt.startsWith('review:'))
    expect(revised).toHaveLength(1)
  })

  it('re-runs a held-open node the quit cut down rather than replaying it', async () => {
    // The review itself never completed, so there is nothing to replay: it
    // runs from its beginning like any interrupted node.
    const before = rig({ gated: reviewing }, () => (_prompt, tools) => {
      tools.block({ reason: 'which way?' })
    })
    const intent = join(before.repo, 'intent.md')
    writeFileSync(intent, 'the intent\n')
    const started = await before.engine.start(startRequest(before.repo, 'gated', { intent }))
    await until(() => before.engine.runs()[0].waiting === true)

    const after = relaunch(before, { gated: reviewing }, (nodeId) =>
      nodeId === 'review'
        ? (_prompt, tools) => {
            writeFileSync(outputPath(tools.taskPrompt, 'review.md'), 'approved\n')
            tools.complete({ summary: 'reviewed' })
          }
        : (_prompt, tools) => tools.complete({ summary: 'fixed it' })
    )

    await after.engine.resume(started.id)
    await until(() => after.engine.runs()[0].status === 'complete')

    // One record for the review, not two, and a real session behind it.
    const run = after.engine.runs()[0]
    expect(run.nodes.filter((node) => node.id === 'review')).toHaveLength(1)
    expect(after.sessions.prompts.filter((prompt) => prompt.startsWith('review:')).length)
      .toBeGreaterThan(0)
    // Revised in the same session it opened, so no fresh revision was needed.
    expect(run.nodes.find((node) => node.id === 'review·r1')?.status).toBe('complete')
  })
})

describe('the interruption notice', () => {
  it('is delivered when the session wakes, once, and the clear survives a restart', async () => {
    const { before, runId } = await interruptedRun()
    const after = relaunch(before, { gated }, planThenPark)
    expect(after.engine.runs()[0].noticePending).toBe(true)

    // Nobody else's turn wakes it.
    after.engine.wake('someone-else')
    expect(after.delivered).toEqual([])

    after.engine.wake('orchestrator-1')
    expect(after.delivered).toHaveLength(1)
    const notice = after.delivered[0]
    expect(notice.sessionId).toBe('orchestrator-1')
    expect(notice.text).toContain(`run ${runId}`)
    expect(notice.text).toContain(INTERRUPTED_MESSAGE)
    expect(notice.text).toContain('node "gate"')
    expect(notice.text).toContain(`crucible_resume tool (runId "${runId}")`)

    // Said once: the flag is cleared and the clear is written, so the next
    // launch does not say it again.
    after.engine.wake('orchestrator-1')
    expect(after.delivered).toHaveLength(1)
    expect(after.engine.runs()[0].noticePending).toBeUndefined()
    expect(createRunStore(after.stateDir).load()[0].noticePending).toBeUndefined()
  })

  it('stays owed when delivery fails, and lands on the next wake', async () => {
    const { before } = await interruptedRun()
    const after = relaunch(before, { gated }, planThenPark)

    after.refuseDelivery(true)
    after.engine.wake('orchestrator-1')
    expect(after.delivered).toEqual([])
    expect(after.engine.runs()[0].noticePending).toBe(true)

    after.refuseDelivery(false)
    after.engine.wake('orchestrator-1')
    expect(after.delivered).toHaveLength(1)
    expect(after.engine.runs()[0].noticePending).toBeUndefined()
  })

  it('says the run was resumed when it has been, rather than repeating the quit', async () => {
    const { before, runId } = await interruptedRun()
    const after = relaunch(before, { gated }, () => async (prompt, tools) => {
      await new Promise((resolve) => setTimeout(resolve, 60))
      writeFileSync(outputPath(prompt, 'verdict.md'), 'approved\n')
      tools.complete({ summary: 'judged it' })
    })

    await after.engine.resume(runId)
    // Resume itself says nothing (ADR 0017's channel is not multiplied), so
    // the notice is still owed and now describes a run that is working.
    expect(after.delivered).toEqual([])
    expect(after.engine.runs()[0].noticePending).toBe(true)

    after.engine.wake('orchestrator-1')
    const notice = after.delivered[0]
    expect(notice.text).toContain('has since been resumed')
    expect(notice.text).toContain('node "gate"')
    expect(notice.text).not.toContain('crucible_resume')

    await until(() => after.engine.runs()[0].status === 'complete')
  })

  it('is settled by any message that reaches the orchestrator', async () => {
    const { before, runId } = await interruptedRun()
    const after = relaunch(before, { gated }, () => (_prompt, tools) => {
      tools.block({ reason: 'which way again?' })
    })

    await after.engine.resume(runId)
    // The blocker is a message to the same orchestrator, so what the notice
    // was for — waking that session about this run — has happened.
    await until(() => after.engine.runs()[0].waiting === true)
    expect(after.delivered.at(-1)?.text).toContain('raised a blocker')
    expect(after.engine.runs()[0].noticePending).toBeUndefined()
    expect(createRunStore(after.stateDir).load()[0].noticePending).toBeUndefined()

    after.engine.wake('orchestrator-1')
    expect(after.delivered.filter((message) => message.text.includes('was interrupted'))).toEqual(
      []
    )
  })

  it('is owed to whichever session adopts the run', async () => {
    const { before, runId } = await interruptedRun()
    const after = relaunch(before, { gated }, planThenPark)

    after.engine.adopt(runId, 'orchestrator-2')
    // Adoption moves the seat and settles nothing: the new session's next
    // wake receives it.
    expect(after.engine.runs()[0].noticePending).toBe(true)
    after.engine.wake('orchestrator-1')
    expect(after.delivered).toEqual([])
    after.engine.wake('orchestrator-2')
    expect(after.delivered.at(-1)?.sessionId).toBe('orchestrator-2')
  })
})
