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
  recordsOnDisk,
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
      prompt: `write the spec; write ${join(ctx.artifactDir, 'spec.md')}`,
      reads: [ctx.inputs.intent],
      outputs: { spec: { file: 'spec.md', desc: 'the Spec' } }
    })
    const gate = await ctx.node('gate', {
      prompt: `judge the branch; write ${join(ctx.artifactDir, 'verdict.md')}`,
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

/** The gate, picking up where it stopped and finishing. */
const finishTheGate: NodeScript = (_prompt, tools) => {
  writeFileSync(outputPath(tools.taskPrompt, 'verdict.md'), 'approved\n')
  tools.complete({ summary: 'judged it', verdict: { verdict: 'approved' } })
}

/**
 * A run left exactly as an app quit leaves one: planner complete, gate holding
 * a blocked session, the record on disk still saying `running`. The engine that
 * started it is abandoned rather than disposed, because a quit does not get to
 * tidy up either.
 */
async function interruptedRun(
  defs: Record<string, WorkflowDef> = { gated },
  script: (nodeId: string) => NodeScript = planThenPark,
  options: { readonly keepSessions?: boolean } = {}
): Promise<{ before: Rig; runId: string }> {
  const before = rig(defs, script, options)
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
    // The session the cut node was working in is named on its record: that
    // is what resume reopens.
    expect(run.nodes[1].sessionToken).toBeDefined()
    // The orchestrator has not been told: no shell exists this early, so the
    // debt rides on the record.
    expect(run.noticePending).toBe(true)
    expect(after.delivered).toEqual([])
    // Written through, so the next launch reads the settled record.
    expect(recordsOnDisk(after)[0].status).toBe('interrupted')

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
    // The launch that wrote these is gone, and its quit put them on disk.
    store.flush()

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
  it('continues the cut node in its own session and finishes the run', async () => {
    const { before, runId } = await interruptedRun()
    const cut = before.engine.runs()[0].nodes[1]
    const token = cut.sessionToken
    const worktree = before.engine.runs()[0].worktreePath ?? ''
    const branch = before.engine.runs()[0].branch ?? ''
    const plannerEnded = before.engine.runs()[0].nodes[0].endedAt

    const cwds: string[] = []
    const continued: boolean[] = []
    const after = relaunch(before, { gated }, () => (prompt, tools) => {
      cwds.push(tools.cwd)
      continued.push(tools.continued)
      writeFileSync(outputPath(tools.taskPrompt, 'verdict.md'), 'approved\n')
      writeFileSync(join(tools.cwd, 'gate-was-here.txt'), prompt.slice(0, 8))
      tools.complete({ summary: 'judged it', verdict: { verdict: 'approved' } })
    })

    await after.engine.resume(runId)
    await until(() => after.engine.runs()[0].status === 'complete')
    const run = after.engine.runs()[0]

    // Only the cut node was worked on; the planner was handed back from its
    // record, so nothing was spent on it.
    expect(after.sessions.requests).toHaveLength(1)
    expect(cwds).toEqual([worktree])
    // Its own session, reopened: the same conversation, not a new one.
    expect(after.sessions.requests[0].resumeToken).toBe(token)
    expect(continued).toEqual([true])
    // And it is told it is continuing, not handed its task afresh.
    expect(after.sessions.prompts[0]).toContain('same session')
    expect(after.sessions.prompts[0]).not.toContain('judge the branch')

    // One record for the gate, the one the quit cut down: no ghost, no
    // second attempt.
    expect(run.nodes.map((node) => node.id)).toEqual(['planner', 'gate'])
    expect(run.nodes[1].status).toBe('complete')
    expect(run.nodes[1].verdict).toEqual({ verdict: 'approved' })
    expect(run.nodes[1].error).toBeUndefined()

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
    expect(existsSync(join(worktree, 'gate-was-here.txt'))).toBe(true)

    // Its work is committed on its own branch, and the completion goes to the
    // orchestrator it always had.
    expect(run.finalCommit).toBe(git(before.repo, 'rev-parse', branch))
    const ending = after.delivered.at(-1)
    expect(ending?.sessionId).toBe('orchestrator-1')
    expect(ending?.text).toContain('completed')
    expect(ending?.text).toContain(branch)
  })

  it('never drops the burned money from the record, even before new stats arrive', async () => {
    const { before, runId } = await interruptedRun()
    const burned = before.engine.runs()[0].nodes[1].cost ?? 0
    expect(burned).toBeGreaterThan(0)

    // The continued node blocks without a line of activity, so no stats
    // snapshot has happened yet: the record must still say what the first
    // life spent.
    const after = relaunch(before, { gated }, () => (_prompt, tools) => {
      tools.block({ reason: 'which way?' })
    })
    await after.engine.resume(runId)
    await until(() => after.engine.runs()[0].waiting === true)

    expect(after.engine.runs()[0].nodes[1].cost ?? 0).toBeGreaterThanOrEqual(burned)
  })

  it('bills the continued turns once, on top of what the node had spent', async () => {
    const { before, runId } = await interruptedRun()
    const cut = before.engine.runs()[0].nodes[1]
    const burned = cut.cost ?? 0
    const calls = cut.toolCalls ?? 0
    expect(burned).toBeGreaterThan(0)
    expect(calls).toBeGreaterThan(0)

    // The reopened session reports what it spent before the quit as well as
    // after, the way a session file does; the record must add one turn's
    // worth, not the whole conversation twice.
    const after = relaunch(before, { gated }, () => finishTheGate)
    await after.engine.resume(runId)
    await until(() => after.engine.runs()[0].status === 'complete')

    // The scripted session bills a quarter per turn and three tool calls:
    // two turns, so twice that and no more. Billing the reopened session's
    // past again would show three turns' worth.
    const node = after.engine.runs()[0].nodes[1]
    expect(node.cost).toBe(burned * 2)
    expect(node.toolCalls).toBe(calls * 2)
  })

  it('keeps the cut node’s transcript and adds to it', async () => {
    const { before, runId } = await interruptedRun()
    // What the quit leaves on disk is what the next launch reads.
    before.store.flush()
    const firstLife = await before.engine.nodeTranscript(runId, 'gate')
    expect(firstLife.length).toBeGreaterThan(0)

    const after = relaunch(before, { gated }, () => finishTheGate)
    await after.engine.resume(runId)
    await until(() => after.engine.runs()[0].status === 'complete')

    // One transcript for one node, still there and now longer: the run view
    // reads the whole of what the node did, across the quit.
    const both = await after.engine.nodeTranscript(runId, 'gate')
    expect(both).not.toEqual([])
    expect(JSON.stringify(both)).toContain('turn 2')
  })

  it('clears a dismissal, because a run that is working again must show', async () => {
    const { before, runId } = await interruptedRun()
    const after = relaunch(before, { gated }, () => finishTheGate)

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

  it('refuses a complete run, a running one, and a second resume racing the first', async () => {
    const { before, runId } = await interruptedRun()
    const after = relaunch(before, { gated }, () => async (_prompt, tools) => {
      // Slow enough that the second resume lands while the first is working.
      await new Promise((resolve) => setTimeout(resolve, 40))
      writeFileSync(outputPath(tools.taskPrompt, 'verdict.md'), 'approved\n')
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
          prompt: `write the spec; write ${join(ctx.artifactDir, 'spec.md')}`,
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
    // run until a session adopts it.
    expect(run.sessionId).toBeUndefined()
    expect(run.noticePending).toBeUndefined()
    expect(run.waiting).toBe(true)
    expect(denied.delivered).toEqual([])
  })
})

describe('resume over every stop', () => {
  // A workflow whose only node fails outright, which is the run failing
  // rather than the app going away.
  const single: WorkflowDef = {
    description: 'one node',
    inputs: { intent: 'the intent document' },
    plan: (): PlannedNode[] => [{ id: 'work' }],
    run: async (ctx) => {
      const done = await ctx.node('work', {
        prompt: `do the work; write ${join(ctx.artifactDir, 'report.md')}`,
        reads: [ctx.inputs.intent],
        outputs: { report: { file: 'report.md', desc: 'the report' } }
      })
      return { summary: done.summary }
    }
  }

  async function startedRun(script: (nodeId: string) => NodeScript): Promise<Rig> {
    const built = rig({ solo: single }, script)
    const intent = join(built.repo, 'intent.md')
    writeFileSync(intent, 'the intent\n')
    await built.engine.start(startRequest(built.repo, 'solo', { intent }))
    return built
  }

  it('puts a failed run back to work, continuing the node that failed', async () => {
    // Three rejected completions fail the node, which fails the run; then
    // the same agent, continued, writes what it owed.
    let helpful = false
    const built = await startedRun(() => (_prompt, tools) => {
      if (!helpful) {
        tools.complete({ summary: 'claimed done without writing anything' })
        return
      }
      writeFileSync(outputPath(tools.taskPrompt, 'report.md'), 'the report\n')
      tools.complete({ summary: 'wrote it this time' })
    })
    await until(() => built.engine.runs()[0].status === 'failed')
    const failed = built.engine.runs()[0]
    expect(failed.nodes[0].status).toBe('failed')
    const token = failed.nodes[0].sessionToken
    expect(token).toBeDefined()

    helpful = true
    await built.engine.resume(failed.id)
    await until(() => built.engine.runs()[0].status === 'complete')

    // The same node record, continued in the same session: no second
    // attempt, and the error it failed with is gone.
    const run = built.engine.runs()[0]
    expect(run.nodes.map((node) => node.id)).toEqual(['work'])
    expect(run.nodes[0].status).toBe('complete')
    expect(run.nodes[0].error).toBeUndefined()
    expect(built.sessions.requests.at(-1)?.resumeToken).toBe(token)
  })

  it('puts a cancelled run back to work the same way', async () => {
    let helpful = false
    const built = await startedRun(() => (_prompt, tools) => {
      // Says nothing at all until it is told to finish, so the run is
      // cancelled while the node is still working.
      if (!helpful) return
      writeFileSync(outputPath(tools.taskPrompt, 'report.md'), 'the report\n')
      tools.complete({ summary: 'finished after the cancel' })
    })
    await until(() => built.sessions.prompts.length > 0)
    const runId = built.engine.runs()[0].id
    built.engine.cancel(runId)
    await until(() => built.engine.runs()[0].status === 'cancelled')

    helpful = true
    await built.engine.resume(runId)
    await until(() => built.engine.runs()[0].status === 'complete')
    expect(built.engine.runs()[0].nodes[0].summary).toBe('finished after the cancel')
  })
})

describe('a clean restart', () => {
  it('runs the node again from its prompt, as a revision beside what stopped', async () => {
    const { before, runId } = await interruptedRun()
    const cut = before.engine.runs()[0].nodes[1]

    const openings: string[] = []
    const after = relaunch(before, { gated }, () => (prompt, tools) => {
      openings.push(prompt)
      writeFileSync(outputPath(prompt, 'verdict.md'), 'approved\n')
      tools.complete({ summary: 'judged it fresh' })
    })
    await after.engine.resume(runId, 'clean-restart')
    await until(() => after.engine.runs()[0].status === 'complete')
    const run = after.engine.runs()[0]

    // A fresh session, told what it is picking up, with the node's own task.
    expect(after.sessions.requests[0].resumeToken).toBeUndefined()
    expect(openings[0]).toContain('judge the branch')
    expect(openings[0]).toContain('fresh session')

    // The attempt that stopped keeps its record, its error and its spend; the
    // new attempt is a revision that follows it.
    const stopped = run.nodes.find((node) => node.id === 'gate')
    expect(stopped?.status).toBe('interrupted')
    expect(stopped?.cost).toBe(cut.cost)
    const restarted = run.nodes.find((node) => node.id === 'gate·r1')
    expect(restarted?.status).toBe('complete')
    expect(restarted?.summary).toBe('judged it fresh')
    expect(restarted?.parents).toContain('gate')

    // Two transcripts, both readable: the point of recording it as a revision.
    expect(await after.engine.nodeTranscript(runId, 'gate')).not.toEqual([])
    expect(await after.engine.nodeTranscript(runId, 'gate·r1')).not.toEqual([])
  })

  it('is what a node with no session left gets, and the log says so', async () => {
    // A launch whose node sessions leave nothing behind: what every record
    // written before sessions outlived the app looks like.
    const logged: Record<string, unknown>[] = []
    const { before, runId } = await interruptedRun({ gated }, planThenPark, {
      keepSessions: false
    })
    expect(before.engine.runs()[0].nodes[1].sessionToken).toBeUndefined()

    const after = relaunch(
      before,
      { gated },
      () => (prompt, tools) => {
        writeFileSync(outputPath(prompt, 'verdict.md'), 'approved\n')
        tools.complete({ summary: 'judged it fresh' })
      },
      { log: (event) => logged.push(event), keepSessions: false }
    )
    await after.engine.resume(runId)
    await until(() => after.engine.runs()[0].status === 'complete')

    // Never silently: the record shows a second attempt, and the log names it.
    expect(after.engine.runs()[0].nodes.map((node) => node.id)).toEqual([
      'planner',
      'gate',
      'gate·r1'
    ])
    expect(after.sessions.prompts[0]).toContain('judge the branch')
    expect(logged).toContainEqual(
      expect.objectContaining({ event: 'node_clean_restart', nodeId: 'gate', asked: false })
    )
  })

  it('is the fallback when a recorded session will not reopen', async () => {
    const logged: Record<string, unknown>[] = []
    const { before, runId } = await interruptedRun()
    // The token is on the record, and nothing will open it: a session file
    // deleted, or a state directory that moved.
    const record = createRunStore(before.stateDir)
    before.store.flush()
    const saved = record.load()[0]
    record.save({
      ...saved,
      nodes: saved.nodes.map((node) =>
        node.id === 'gate' ? { ...node, sessionToken: '/gone/session.jsonl' } : node
      )
    })
    record.flush()

    const after = rig(
      { gated },
      () => (prompt, tools) => {
        writeFileSync(outputPath(prompt, 'verdict.md'), 'approved\n')
        tools.complete({ summary: 'judged it fresh' })
      },
      { repo: before.repo, stateDir: before.stateDir, log: (event) => logged.push(event) }
    )
    await after.engine.resume(runId)
    await until(() => after.engine.runs()[0].status === 'complete')

    expect(logged).toContainEqual(
      expect.objectContaining({ event: 'node_session_unreadable', nodeId: 'gate' })
    )
    expect(after.engine.runs()[0].nodes.map((node) => node.id)).toContain('gate·r1')
  })

  // Twice stopped, with a clean restart in between: the completion lives on
  // `gate·r1` while the base record stays `interrupted` for good. The record
  // chain is the one answer to "is this node done" — read the base record
  // alone and the next resume reopens a finished node's session, pays for a
  // turn on work that is done, and pushes a second record under one id.
  it('completes a node for good: the next resume replays it rather than re-running it', async () => {
    const threeStep: WorkflowDef = {
      description: 'a planner, a gate, a builder',
      inputs: { intent: 'the intent document' },
      plan: (): PlannedNode[] => [
        { id: 'planner' },
        { id: 'gate', parents: ['planner'] },
        { id: 'builder', parents: ['gate'] }
      ],
      run: async (ctx) => {
        const planned = await ctx.node('planner', {
          prompt: `write the spec; write ${join(ctx.artifactDir, 'spec.md')}`,
          reads: [ctx.inputs.intent],
          outputs: { spec: { file: 'spec.md', desc: 'the Spec' } }
        })
        const gate = await ctx.node('gate', {
          prompt: `judge the branch; write ${join(ctx.artifactDir, 'verdict.md')}`,
          reads: [planned.outputs.spec],
          outputs: { verdict: { file: 'verdict.md', desc: 'the verdict' } }
        })
        const built = await ctx.node('builder', {
          prompt: `build it; write ${join(ctx.artifactDir, 'report.md')}`,
          reads: [gate.outputs.verdict],
          outputs: { report: { file: 'report.md', desc: 'the report' } }
        })
        return { summary: built.summary }
      }
    }
    const write =
      (file: string, summary: string): NodeScript =>
      (_prompt, tools) => {
        writeFileSync(outputPath(tools.taskPrompt, file), 'done\n')
        tools.complete({ summary })
      }
    const park: NodeScript = (_prompt, tools) => {
      tools.activity('working…')
      tools.block({ reason: 'which way?' })
    }

    // Life 1: the planner completes, the gate parks, the app quits.
    const first = rig({ threeStep }, (nodeId) =>
      nodeId === 'planner' ? write('spec.md', 'wrote the spec') : park
    )
    const intent = join(first.repo, 'intent.md')
    writeFileSync(intent, 'the intent\n')
    const started = await first.engine.start(startRequest(first.repo, 'threeStep', { intent }))
    await until(() =>
      first.engine
        .runs()[0]
        .nodes.some((node) => node.status === 'blocked' && node.cost !== undefined)
    )

    // Life 2: a clean restart. `gate·r1` completes, the builder parks, quit.
    const second = relaunch(first, { threeStep }, (nodeId) =>
      nodeId === 'gate' ? write('verdict.md', 'judged it fresh') : park
    )
    await second.engine.resume(started.id, 'clean-restart')
    await until(() =>
      second.engine
        .runs()[0]
        .nodes.some(
          (node) => node.id === 'builder' && node.status === 'blocked' && node.cost !== undefined
        )
    )
    expect(second.engine.runs()[0].nodes.find((node) => node.id === 'gate·r1')?.status).toBe(
      'complete'
    )

    // Life 3: a plain resume. Only the builder goes back to work.
    const third = relaunch(second, { threeStep }, () => (_prompt, tools) => {
      writeFileSync(outputPath(tools.taskPrompt, 'report.md'), 'the report\n')
      tools.complete({ summary: 'built it' })
    })
    await third.engine.resume(started.id)
    await until(() => third.engine.runs()[0].status !== 'running')
    const run = third.engine.runs()[0]

    // No session was opened for the gate: its completed revision is handed
    // back from the record, exactly as a completed base node is.
    expect(third.sessions.prompts.filter((prompt) => prompt.startsWith('gate'))).toEqual([])
    // One record per id: the completed gate·r1 keeps its summary, ungrown.
    expect(run.nodes.filter((node) => node.id === 'gate·r1')).toHaveLength(1)
    expect(run.nodes.find((node) => node.id === 'gate·r1')?.summary).toBe('judged it fresh')
    expect(run.nodes.find((node) => node.id === 'builder')?.summary).toBe('built it')
    expect(run.status).toBe('complete')
  }, 20000)
})

describe('what a resumed run does not do again', () => {
  it('hands back the answer to a check-in it already had, and asks nothing', async () => {
    const asking: WorkflowDef = {
      description: 'a planner, a question, a gate',
      inputs: { intent: 'the intent document' },
      plan: (): PlannedNode[] => [{ id: 'planner' }, { id: 'gate', parents: ['planner'] }],
      run: async (ctx) => {
        await ctx.node('planner', {
          prompt: `write the spec; write ${join(ctx.artifactDir, 'spec.md')}`,
          reads: [ctx.inputs.intent],
          outputs: { spec: { file: 'spec.md', desc: 'the Spec' } }
        })
        const said = await ctx.ask({ reason: 'ship it?' })
        const gate = await ctx.node('gate', { prompt: `judge it: ${said}` })
        return { summary: gate.summary }
      }
    }
    // The question is asked and answered, and the quit lands on the gate.
    const before = rig({ gated: asking }, (nodeId) =>
      nodeId === 'planner'
        ? (prompt, tools) => {
            writeFileSync(outputPath(prompt, 'spec.md'), 'the spec\n')
            tools.complete({ summary: 'wrote the spec' })
          }
        : (_prompt, tools) => tools.block({ reason: 'which way?' })
    )
    const intent = join(before.repo, 'intent.md')
    writeFileSync(intent, 'the intent\n')
    const started = await before.engine.start(startRequest(before.repo, 'gated', { intent }))
    await until(() => before.engine.runs()[0].waiting === true)
    before.engine.answer(started.id, 'ship it')
    await until(() => before.engine.runs()[0].nodes.some((node) => node.status === 'blocked'))

    const after = relaunch(before, { gated: asking }, () => (_prompt, tools) => {
      tools.complete({ summary: 'judged it' })
    })
    await after.engine.resume(started.id)
    await until(() => after.engine.runs()[0].status === 'complete')

    // The human's one gate is not passed a second time: nobody was asked,
    // and the workflow got what it was told the first time.
    expect(after.delivered.filter((message) => message.text.includes('ship it?'))).toEqual([])
    expect(after.engine.runs()[0].waiting).toBeFalsy()
    const recorded = after.engine.runs()[0].effects ?? []
    expect(recorded.map((effect) => effect.value)).toEqual(['ship it'])
  })

  it('hands back an effect it already recorded instead of doing the work again', async () => {
    let gateRuns = 0
    const gating: WorkflowDef = {
      description: 'a gate the workflow runs itself, then a node',
      inputs: { intent: 'the intent document' },
      plan: (): PlannedNode[] => [{ id: 'work' }],
      run: async (ctx) => {
        // The five-minute `make check` of a real build workflow, and the
        // commit hash the rest of the run is measured against.
        const checked = await ctx.effect('make-check', () => {
          gateRuns += 1
          return { ok: true, at: `run ${gateRuns}` }
        })
        const done = await ctx.node('work', {
          prompt: `fix what the gate said: ${JSON.stringify(checked)}; write ${join(ctx.artifactDir, 'report.md')}`,
          reads: [ctx.inputs.intent],
          outputs: { report: { file: 'report.md', desc: 'the report' } }
        })
        return { summary: done.summary, checked }
      }
    }

    const before = rig({ gated: gating }, () => (_prompt, tools) => {
      tools.block({ reason: 'which way?' })
    })
    const intent = join(before.repo, 'intent.md')
    writeFileSync(intent, 'the intent\n')
    const started = await before.engine.start(startRequest(before.repo, 'gated', { intent }))
    await until(() => before.engine.runs()[0].waiting === true)
    expect(gateRuns).toBe(1)

    const after = relaunch(before, { gated: gating }, () => (prompt, tools) => {
      writeFileSync(outputPath(tools.taskPrompt, 'report.md'), prompt.slice(0, 10))
      tools.complete({ summary: 'fixed it' })
    })
    await after.engine.resume(started.id)
    await until(() => after.engine.runs()[0].status === 'complete')

    // The gate ran once, in the life that was cut, and the resumed run was
    // handed what it produced.
    expect(gateRuns).toBe(1)
    expect(after.engine.runs()[0].outputs).toMatchObject({ checked: { ok: true, at: 'run 1' } })
    expect(after.engine.runs()[0].effects?.map((effect) => effect.key)).toEqual(['make-check'])
  })

  it('refuses two effects under one id, as it refuses two nodes under one id', async () => {
    const twice: WorkflowDef = {
      description: 'records the same id twice',
      inputs: {},
      run: async (ctx) => {
        await ctx.effect('gate', () => 1)
        await ctx.effect('gate', () => 2)
        return {}
      }
    }
    const built = rig({ solo: twice }, () => () => {})
    await built.engine.start(startRequest(built.repo, 'solo', {}))
    await until(() => built.engine.runs()[0].status === 'failed')
    expect(built.engine.runs()[0].error).toContain('duplicate effect id "gate"')
  })

  it('refuses them on a resumed run too, where the second one would replay', async () => {
    // An id asked for twice is the workflow's mistake whether the value comes
    // out of the work or off the record: a resumed run refuses it where a
    // first life did, rather than quietly handing the same value back twice.
    let calls = 0
    const twice: WorkflowDef = {
      description: 'one effect, then a node, then the same effect again',
      inputs: { intent: 'the intent document' },
      plan: (): PlannedNode[] => [{ id: 'work' }],
      run: async (ctx) => {
        await ctx.effect('gate', () => (calls += 1))
        const done = await ctx.node('work', {
          prompt: 'do the work',
          reads: [ctx.inputs.intent]
        })
        await ctx.effect('gate', () => (calls += 1))
        return { summary: done.summary }
      }
    }

    const before = rig({ solo: twice }, () => (_prompt, tools) => {
      tools.activity('working…')
      tools.block({ reason: 'which way?' })
    })
    const intent = join(before.repo, 'intent.md')
    writeFileSync(intent, 'the intent\n')
    const started = await before.engine.start(startRequest(before.repo, 'solo', { intent }))
    await until(() => before.engine.runs()[0].waiting === true)
    expect(calls).toBe(1)

    const after = relaunch(before, { solo: twice }, () => (_prompt, tools) => {
      tools.complete({ summary: 'did the work' })
    })
    await after.engine.resume(started.id)
    await until(() => after.engine.runs()[0].status === 'failed')
    expect(after.engine.runs()[0].error).toContain('duplicate effect id "gate"')
    // The first call replayed; the second was refused before any work ran.
    expect(calls).toBe(1)
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
        prompt: `review the branch; write ${join(ctx.artifactDir, 'review.md')}`,
        outputs: { review: { file: 'review.md', desc: 'the review' } }
      })
      await ctx.node('fixer', { prompt: 'fix what the review found' })
      const again = await review.revise('the fixer is done; look again', { from: ['fixer'] })
      review.close()
      return { summary: again.summary }
    }
  }

  it('revises a replayed node in the session that node was working in', async () => {
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
    const reviewToken = before.engine.runs()[0].nodes[0].sessionToken

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

    // The completed review was replayed — no session opened for it — and the
    // fixer, which the quit cut down, carried on in its own.
    const revision = run.nodes.find((node) => node.id === 'review·r1')
    expect(revision?.status).toBe('complete')
    expect(revision?.summary).toBe('reviewed again')
    // The revision follows the record it revises and the reviewer that
    // triggered it, exactly as a first run writes those edges.
    expect(revision?.parents).toEqual(['review', 'fixer'])

    // The revision went into the review's own session, which is the whole
    // point of holding one open: it was not told its earlier work was gone.
    const reopened = after.sessions.requests.filter(
      (request) => request.resumeToken === reviewToken
    )
    expect(reopened).toHaveLength(1)
    const revised = after.sessions.prompts.filter((prompt) => prompt.startsWith('review:'))
    expect(revised).toHaveLength(1)
    expect(revised[0]).not.toContain('review the branch')
    expect(run.outputs).toEqual({ summary: 'reviewed again' })
  })

  it('continues a held-open node the quit cut down rather than replaying it', async () => {
    // The review itself never completed, so there is nothing to replay: it
    // carries on in its own session like any node the quit cut down.
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

    // One record for the review, not two, and its own session behind it.
    const run = after.engine.runs()[0]
    expect(run.nodes.filter((node) => node.id === 'review')).toHaveLength(1)
    expect(after.sessions.requests[0].resumeToken).toBeDefined()
    // Revised in the same session it continued in, so no fresh attempt was
    // needed.
    expect(run.nodes.find((node) => node.id === 'review·r1')?.status).toBe('complete')
  })

  // Review-4 reproduction. The quit catches the run mid-revision: the base
  // record is complete with its session on disk, and `review·r1` — the
  // in-session revision the quit cut down — carries no token of its own
  // (`openRevision` records none). `resumePlan` for that record chain is
  // empty, and `resumeSentence`'s empty-plan fallback tells the orchestrator
  // the node "has no session left to continue, so it runs again from its
  // prompt as a fresh attempt". The engine does the opposite, as the resume
  // half of this test shows: it replays the completion and the re-issued
  // revise() continues the review's own session, billing nothing twice.
  it('does not tell the orchestrator a revision the engine will continue is a fresh attempt', async () => {
    // First life: the review completes and is held open, the fixer completes,
    // and the revision blocks — so the quit catches `review·r1` mid-flight.
    const before = rig({ gated: reviewing }, (nodeId) =>
      nodeId === 'review'
        ? (_prompt, tools, turn) => {
            if (turn === 1) {
              writeFileSync(outputPath(tools.taskPrompt, 'review.md'), 'changes required\n')
              tools.complete({ summary: 'reviewed once' })
              return
            }
            tools.activity('looking again…')
            tools.block({ reason: 'which way?' })
          }
        : (_prompt, tools) => tools.complete({ summary: 'fixed it' })
    )
    const intent = join(before.repo, 'intent.md')
    writeFileSync(intent, 'the intent\n')
    const started = await before.engine.start(startRequest(before.repo, 'gated', { intent }))
    await until(() => before.engine.runs()[0].waiting === true)
    const blocked = (): { cost?: number } | undefined =>
      before.engine.runs()[0].nodes.find((node) => node.status === 'blocked')
    await until(() => blocked()?.cost !== undefined)
    const reviewToken = before.engine.runs()[0].nodes.find(
      (node) => node.id === 'review'
    )?.sessionToken
    expect(reviewToken).toBeDefined()

    const after = relaunch(before, { gated: reviewing }, (nodeId) =>
      nodeId === 'review'
        ? (_prompt, tools) => {
            writeFileSync(outputPath(tools.taskPrompt, 'review.md'), 'approved\n')
            tools.complete({ summary: 'reviewed again' })
          }
        : (_prompt, tools) => tools.complete({ summary: 'fixed it' })
    )

    // The state the sweep leaves: base complete with its session, the
    // revision interrupted with none.
    const swept = after.engine.runs()[0]
    expect(swept.status).toBe('interrupted')
    expect(swept.nodes.find((node) => node.id === 'review')?.status).toBe('complete')
    expect(swept.nodes.find((node) => node.id === 'review·r1')?.status).toBe('interrupted')
    expect(swept.nodes.find((node) => node.id === 'review·r1')?.sessionToken).toBeUndefined()

    // The notice, composed from that record.
    after.engine.deliverNotices('orchestrator-1')
    const notice = after.delivered.find((message) => message.text.includes('was interrupted'))
    expect(notice).toBeDefined()

    // What the click it describes actually does: the completion is replayed,
    // and the re-issued revise() reopens the review's own session — one
    // request, the base record's token, no fresh attempt from a prompt.
    await after.engine.resume(started.id)
    await until(() => after.engine.runs()[0].status === 'complete')
    const run = after.engine.runs()[0]
    expect(run.nodes.find((node) => node.id === 'review·r2')?.status).toBe('complete')
    expect(after.sessions.requests).toHaveLength(1)
    expect(after.sessions.requests[0].resumeToken).toBe(reviewToken)

    // So the notice must not have claimed the opposite act.
    expect(notice?.text).not.toContain('runs again from its prompt')
    expect(notice?.text).not.toContain('no session left')
  })

  // A record written before sessions outlived the app carries no
  // `sessionToken` anywhere — main recorded none. Resumed over one, the
  // engine replays the review's completion, and the re-issued revise() finds
  // no session to reopen (`replayedHandle.revise` reads the complete
  // record's token), so it runs the revision again from its prompt in a
  // fresh session. The notice composed from that same record must say that
  // act, the way the restarted branch already does for a stopped node with
  // no token — not promise a continuation the engine cannot make.
  it('does not promise a pre-token record a continuation the engine cannot make', async () => {
    const before = rig({ gated: reviewing }, (nodeId) =>
      nodeId === 'review'
        ? (_prompt, tools, turn) => {
            if (turn === 1) {
              writeFileSync(outputPath(tools.taskPrompt, 'review.md'), 'changes required\n')
              tools.complete({ summary: 'reviewed once' })
              return
            }
            tools.activity('looking again…')
            tools.block({ reason: 'which way?' })
          }
        : (_prompt, tools) => tools.complete({ summary: 'fixed it' })
    )
    const intent = join(before.repo, 'intent.md')
    writeFileSync(intent, 'the intent\n')
    const started = await before.engine.start(startRequest(before.repo, 'gated', { intent }))
    await until(() => before.engine.runs()[0].waiting === true)
    const blocked = (): { cost?: number } | undefined =>
      before.engine.runs()[0].nodes.find((node) => node.status === 'blocked')
    await until(() => blocked()?.cost !== undefined)

    // The quit, then the record as 0.1.22 wrote it: no session tokens at all.
    before.store.flush()
    const runPath = join(before.stateDir, started.id, 'run.json')
    const written = JSON.parse(readFileSync(runPath, 'utf8')) as {
      nodes: Record<string, unknown>[]
    }
    for (const node of written.nodes) delete node.sessionToken
    writeFileSync(runPath, JSON.stringify(written))

    // Not `relaunch`: that flushes again, and this launch must read the
    // record exactly as the old app left it.
    const logged: Record<string, unknown>[] = []
    const after = rig(
      { gated: reviewing },
      (nodeId) =>
        nodeId === 'review'
          ? (_prompt, tools) => {
              writeFileSync(outputPath(tools.taskPrompt, 'review.md'), 'approved\n')
              tools.complete({ summary: 'reviewed again' })
            }
          : (_prompt, tools) => tools.complete({ summary: 'fixed it' }),
      { repo: before.repo, stateDir: before.stateDir, log: (event) => logged.push(event) }
    )
    const swept = after.engine.runs()[0]
    expect(swept.status).toBe('interrupted')
    expect(swept.nodes.find((node) => node.id === 'review')?.status).toBe('complete')
    expect(swept.nodes.find((node) => node.id === 'review')?.sessionToken).toBeUndefined()
    expect(swept.nodes.find((node) => node.id === 'review·r1')?.status).toBe('interrupted')

    after.engine.deliverNotices('orchestrator-1')
    const notice = after.delivered.find((message) => message.text.includes('was interrupted'))
    expect(notice).toBeDefined()

    // What the click it describes actually does: one session request, no
    // token to reopen — a fresh attempt from the prompt.
    await after.engine.resume(started.id)
    await until(() => after.engine.runs()[0].status === 'complete')
    expect(after.sessions.requests).toHaveLength(1)
    expect(after.sessions.requests[0].resumeToken).toBeUndefined()

    // Never silently, on this path as on the direct one: the log names the
    // from-the-prompt re-run the re-issued revise() had to make.
    expect(logged).toContainEqual(
      expect.objectContaining({
        event: 'node_clean_restart',
        nodeId: 'review',
        recordId: 'review·r2',
        asked: false
      })
    )

    // So the notice must not have promised the opposite act.
    expect(notice?.text).not.toContain('continues in the session')
    expect(notice?.text).toContain('runs again from its prompt')
  })
})

describe('the interruption notice', () => {
  it('is delivered when the session wakes, once, and the clear survives a restart', async () => {
    const { before, runId } = await interruptedRun()
    const after = relaunch(before, { gated }, planThenPark)
    expect(after.engine.runs()[0].noticePending).toBe(true)

    // Nobody else's turn wakes it.
    after.engine.deliverNotices('someone-else')
    expect(after.delivered).toEqual([])

    after.engine.deliverNotices('orchestrator-1')
    expect(after.delivered).toHaveLength(1)
    const notice = after.delivered[0]
    expect(notice.sessionId).toBe('orchestrator-1')
    expect(notice.text).toContain(`run ${runId}`)
    expect(notice.text).toContain(INTERRUPTED_MESSAGE)
    expect(notice.text).toContain('node "gate"')
    expect(notice.text).toContain(`crucible_resume tool (runId "${runId}")`)

    // Said once: the flag is cleared and the clear is written, so the next
    // launch does not say it again.
    after.engine.deliverNotices('orchestrator-1')
    expect(after.delivered).toHaveLength(1)
    expect(after.engine.runs()[0].noticePending).toBeUndefined()
    expect(recordsOnDisk(after)[0].noticePending).toBeUndefined()
  })

  it('stays owed when delivery fails, and lands on the next wake', async () => {
    const { before } = await interruptedRun()
    const after = relaunch(before, { gated }, planThenPark)

    after.refuseDelivery(true)
    after.engine.deliverNotices('orchestrator-1')
    expect(after.delivered).toEqual([])
    expect(after.engine.runs()[0].noticePending).toBe(true)

    after.refuseDelivery(false)
    after.engine.deliverNotices('orchestrator-1')
    expect(after.delivered).toHaveLength(1)
    expect(after.engine.runs()[0].noticePending).toBeUndefined()
  })

  it('says the run was resumed when it has been, rather than repeating the quit', async () => {
    const { before, runId } = await interruptedRun()
    const after = relaunch(before, { gated }, () => async (_prompt, tools) => {
      await new Promise((resolve) => setTimeout(resolve, 60))
      writeFileSync(outputPath(tools.taskPrompt, 'verdict.md'), 'approved\n')
      tools.complete({ summary: 'judged it' })
    })

    await after.engine.resume(runId)
    // Resume itself says nothing — a run speaks only through messages to its
    // orchestrator — so the notice is still owed and now describes a run that
    // is working.
    expect(after.delivered).toEqual([])
    expect(after.engine.runs()[0].noticePending).toBe(true)

    // The notice names whatever is working when it is composed, and the node
    // is asked for its model before it starts: waiting for it to be running is
    // what makes the name, rather than the fallback, the thing under test.
    await until(() => after.engine.runs()[0].nodes.some((node) => node.status === 'running'))
    after.engine.deliverNotices('orchestrator-1')
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
    expect(recordsOnDisk(after)[0].noticePending).toBeUndefined()

    after.engine.deliverNotices('orchestrator-1')
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
    after.engine.deliverNotices('orchestrator-1')
    expect(after.delivered).toEqual([])
    after.engine.deliverNotices('orchestrator-2')
    expect(after.delivered.at(-1)?.sessionId).toBe('orchestrator-2')
  })
})
