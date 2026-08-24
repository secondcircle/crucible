// @vitest-environment node
//
// The engine against scripted node sessions and a real git repository: the
// node loop, the orchestrator routing and the worktree life all run exactly
// as shipped, with no SDK session anywhere (the seam is the point).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PlannedNode, WorkflowDef } from './authoring'
import { createWorkflowEngine } from './engine'
import { createRunStore } from './store'
import {
  cleanupScratch,
  git,
  loaderOf,
  outputPath,
  rig,
  scriptedSessions,
  startRequest,
  tempDir,
  until,
  type NodeScript,
  type Rig
} from './testing/engine-rig'

afterEach(cleanupScratch)

const oneNode: WorkflowDef = {
  description: 'one node writing a file into the worktree',
  inputs: { prompt: 'the task file' },
  plan: () => [{ id: 'work' }],
  run: async (ctx) => {
    const result = await ctx.node('work', {
      prompt: 'do the thing',
      reads: [ctx.inputs.prompt],
      outputs: { report: { file: 'report.md', desc: 'what happened' } }
    })
    return { summary: result.summary }
  }
}

describe('the engine end to end', () => {
  it('runs a workflow in its own worktree and reports completion to the orchestrator', async () => {
    const { engine, repo, stateDir, delivered } = rig({ solo: oneNode }, () => {
      return (prompt, tools) => {
        // The node's work: a repo change and its declared artifact.
        writeFileSync(join(tools.cwd, 'made-by-node.txt'), 'work\n')
        writeFileSync(outputPath(prompt, 'report.md'), 'the report\n')
        tools.complete({ summary: 'did the thing' })
      }
    })

    const task = join(repo, 'task.md')
    writeFileSync(task, 'the task\n')
    const started = await engine.start(startRequest(repo, 'solo', { prompt: task }))

    expect(started.status).toBe('running')
    expect(started.branch).toBe(`crucible/run-${started.id}`)
    expect(started.worktreePath).toContain('.crucible/worktrees/run-')
    expect(started.baseCommit).toBe(git(repo, 'rev-parse', 'HEAD'))

    await until(() => engine.runs()[0].status === 'complete')
    const run = engine.runs()[0]

    // The node settled with its summary, artifact and per-session stats.
    expect(run.nodes).toHaveLength(1)
    expect(run.nodes[0].status).toBe('complete')
    expect(run.nodes[0].summary).toBe('did the thing')
    expect(run.nodes[0].artifacts[0].name).toBe('report')
    expect(readFileSync(run.nodes[0].artifacts[0].path, 'utf8')).toBe('the report\n')
    expect(run.outputs).toEqual({ summary: 'did the thing' })

    // The work is committed on the run's own branch; the checkout never moved.
    expect(run.finalCommit).toBe(git(repo, 'rev-parse', run.branch ?? ''))
    expect(run.finalCommit).not.toBe(run.baseCommit)
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(existsSync(join(run.worktreePath ?? '', 'made-by-node.txt'))).toBe(true)

    // Completion is a message to the orchestrator, naming branch and worktree.
    const ending = delivered.at(-1)
    expect(ending?.sessionId).toBe('orchestrator-1')
    expect(ending?.text).toContain(`run ${run.id}`)
    expect(ending?.text).toContain('completed')
    expect(ending?.text).toContain(run.branch ?? '')

    // The record outlives the engine: a fresh store loads it whole.
    const reloaded = createRunStore(stateDir).load()
    expect(reloaded[0].id).toBe(run.id)
    expect(reloaded[0].status).toBe('complete')
  })

  it('rejects a completion whose declared output is missing, then accepts the fix', async () => {
    const { engine, repo, sessions } = rig({ solo: oneNode }, () => {
      return (_prompt, tools, turn) => {
        // First turn: claims done without writing. Second: actually writes.
        if (turn > 1) writeFileSync(outputPath(tools.taskPrompt, 'report.md'), 'now for real\n')
        tools.complete({ summary: `attempt ${turn}` })
      }
    })
    const task = join(repo, 'task.md')
    writeFileSync(task, 'the task\n')
    await engine.start(startRequest(repo, 'solo', { prompt: task }))
    await until(() => engine.runs()[0].status === 'complete')

    expect(sessions.prompts.some((prompt) => prompt.includes('rejected'))).toBe(true)
    expect(engine.runs()[0].nodes[0].summary).toBe('attempt 2')
  })

  it('routes a blocker to the orchestrator and resumes on crucible_answer', async () => {
    const { engine, repo, delivered, sessions } = rig({ solo: oneNode }, () => {
      return (_prompt, tools, turn) => {
        if (turn === 1) {
          tools.block({ reason: 'the env is broken', details: 'no compiler' })
          return
        }
        writeFileSync(outputPath(tools.taskPrompt, 'report.md'), 'fixed\n')
        tools.complete({ summary: 'done after help' })
      }
    })
    const task = join(repo, 'task.md')
    writeFileSync(task, 'the task\n')
    const started = await engine.start(startRequest(repo, 'solo', { prompt: task }))

    await until(() => engine.runs()[0].waiting === true)
    const parked = engine.runs()[0]
    expect(parked.nodes[0].status).toBe('blocked')
    expect(parked.question?.reason).toBe('the env is broken')
    const asked = delivered.at(-1)
    expect(asked?.text).toContain('raised a blocker')
    expect(asked?.text).toContain(`crucible_answer tool (runId "${started.id}")`)

    engine.answer(started.id, 'use the fallback compiler')
    await until(() => engine.runs()[0].status === 'complete')
    expect(engine.runs()[0].waiting).toBe(false)
    expect(engine.runs()[0].question?.answer).toBe('use the fallback compiler')
    expect(
      sessions.prompts.some((prompt) => prompt.includes('Response to your blocker'))
    ).toBe(true)
  })

  it('records a node\u2019s cache miss against the run, and tells nobody', async () => {
    const { engine, repo, stateDir, delivered, recorded } = rig({ solo: oneNode }, () => {
      return (prompt, tools) => {
        tools.cacheMiss({
          provider: 'anthropic',
          model: 'claude-opus-5',
          thinkingLevel: 'high',
          tokensRebilled: 118_211,
          dollarsRebilled: 0.62,
          gapMs: 28_920_000,
          changed: {
            model: 'no',
            thinking: 'no',
            jump: 'no',
            compaction: 'no',
            tools: 'no',
            rolePrompt: 'no'
          }
        })
        writeFileSync(outputPath(prompt, 'report.md'), 'the report\n')
        tools.complete({ summary: 'did the thing' })
      }
    })
    const task = join(repo, 'task.md')
    writeFileSync(task, 'the task\n')
    const started = await engine.start(startRequest(repo, 'solo', { prompt: task }))

    await until(() => engine.runs()[0].status === 'complete')
    const run = engine.runs()[0]

    // One ledger line, sourced to the run, its workflow and the node.
    expect(recorded).toHaveLength(1)
    expect(recorded[0].source).toEqual({
      kind: 'run',
      runId: started.id,
      workflow: 'solo',
      node: 'work',
      // The workspace the run belongs to, not the worktree it works in.
      workspace: repo
    })
    expect(recorded[0].dollarsRebilled).toBe(0.62)

    // The chip's mark: the run counts it, and the record outlives the engine.
    expect(run.nodes[0].cacheMisses).toBe(1)
    expect(createRunStore(stateDir).load()[0].nodes[0].cacheMisses).toBe(1)

    // A miss inside a run never becomes a message to the orchestrator: what
    // it says is what it always says, and nothing about cache is in it.
    expect(delivered.every((message) => !message.text.includes('cache'))).toBe(true)
  })

  it('parks a workflow check-in the same way and hands back the answer verbatim', async () => {
    const asking: WorkflowDef = {
      description: 'asks its orchestrator mid-run',
      inputs: {},
      run: async (ctx) => {
        const ruling = await ctx.ask({ reason: 'which way should the helper go?' })
        return { ruling }
      }
    }
    const { engine, repo, delivered } = rig({ asking }, () => () => {})
    const started = await engine.start(startRequest(repo, 'asking', {}))

    await until(() => engine.runs()[0].waiting === true)
    expect(delivered.at(-1)?.text).toContain('checking in')

    engine.answer(started.id, 'beside its caller')
    await until(() => engine.runs()[0].status === 'complete')
    expect(engine.runs()[0].outputs).toEqual({ ruling: 'beside its caller' })
  })

  it('nudges a node that ends its turn silent, then stalls it out to the orchestrator', async () => {
    const { engine, repo, delivered } = rig({ solo: oneNode }, () => {
      let helped = false
      return (prompt, tools) => {
        if (prompt.includes('was reviewed')) helped = true
        if (!helped) return // says nothing: neither complete nor blocked
        writeFileSync(outputPath(tools.taskPrompt, 'report.md'), 'after the shove\n')
        tools.complete({ summary: 'finally' })
      }
    })
    const task = join(repo, 'task.md')
    writeFileSync(task, 'the task\n')
    const started = await engine.start(startRequest(repo, 'solo', { prompt: task }))

    await until(() => engine.runs()[0].waiting === true)
    expect(engine.runs()[0].nodes[0].status).toBe('stalled')
    expect(delivered.at(-1)?.text).toContain('stalled')

    engine.answer(started.id, 'the outputs list names the file; write it')
    await until(() => engine.runs()[0].status === 'complete')
  })

  it('cancel unwinds the run and says so to the orchestrator', async () => {
    const { engine, repo, delivered } = rig({ solo: oneNode }, () => () => {
      // Never completes: the run only ends because somebody cancels it.
    })
    const task = join(repo, 'task.md')
    writeFileSync(task, 'the task\n')
    const started = await engine.start(startRequest(repo, 'solo', { prompt: task }))

    await until(() => engine.runs()[0].nodes[0]?.status === 'running')
    engine.cancel(started.id)
    await until(() => engine.runs()[0].status === 'cancelled')
    expect(delivered.at(-1)?.text).toContain('cancelled')
    // A cancelled run is no longer pausable: it is not live.
    expect(() => engine.pause(started.id)).toThrow(/not live/)
  })

  it('starts a staged successor on clean completion, continuing the branch from the final commit', async () => {
    const first: WorkflowDef = {
      description: 'stages a successor',
      inputs: {},
      run: async (ctx) => {
        writeFileSync(join(ctx.cwd, 'from-first.txt'), 'first\n')
        writeFileSync(join(ctx.artifactDir, 'baton.md'), 'the baton\n')
        await ctx.stage({ workflow: 'second', inputs: { baton: join(ctx.artifactDir, 'baton.md') } })
      }
    }
    const second: WorkflowDef = {
      description: 'the successor',
      inputs: { baton: 'what the predecessor left' },
      run: async (ctx) => {
        writeFileSync(join(ctx.cwd, 'from-second.txt'), 'second\n')
      }
    }
    const { engine, repo } = rig({ first, second }, () => () => {})
    const started = await engine.start(startRequest(repo, 'first', {}))

    await until(() => engine.runs().some((run) => run.workflow === 'second'))
    await until(() => engine.runs().every((run) => run.status === 'complete'))

    const runs = engine.runs()
    const predecessor = runs.find((run) => run.id === started.id)
    const successor = runs.find((run) => run.workflow === 'second')
    expect(successor?.after).toBe(started.id)
    // Same branch, picked up at the predecessor's final commit.
    expect(successor?.branch).toBe(predecessor?.branch)
    expect(successor?.baseCommit).toBe(predecessor?.finalCommit)
    expect(successor?.sessionId).toBe('orchestrator-1')
    // Both runs' work sits on the one branch.
    const tip = git(repo, 'rev-parse', successor?.branch ?? '')
    expect(tip).toBe(successor?.finalCommit)
  })

  it('refuses a kickoff whose inputs are wrong before any money moves', async () => {
    const { engine, repo } = rig({ solo: oneNode }, () => () => {})
    await expect(
      engine.start(startRequest(repo, 'solo', { prompt: '/nowhere/task.md' }))
    ).rejects.toThrow(/does not exist/)
    await expect(engine.start(startRequest(repo, 'solo', {}))).rejects.toThrow(/needs "prompt"/)
    await expect(
      engine.start(startRequest(repo, 'solo', { prompt: join(repo, 'README.md'), extra: 'x' }))
    ).rejects.toThrow(/no input named "extra"/)
    expect(engine.runs()).toHaveLength(0)
  })

  it('sets the worktree up before a node costs anything, and fails loudly if it cannot', async () => {
    const { engine, repo } = rig({ solo: oneNode }, () => {
      return (prompt, tools) => {
        writeFileSync(outputPath(prompt, 'report.md'), 'the report\n')
        tools.complete({ summary: 'did the thing' })
      }
    })
    const prompt = join(repo, 'task.md')
    writeFileSync(prompt, 'do the thing\n')

    // The repository claims the mechanism and its script refuses. Nothing is
    // worth starting: every node would run the project's checks against a
    // worktree that cannot build.
    mkdirSync(join(repo, '.crucible'), { recursive: true })
    const script = join(repo, '.crucible', 'worktree-setup')
    writeFileSync(script, '#!/usr/bin/env bash\necho "no dependencies here" >&2\nexit 1\n', 'utf8')
    chmodSync(script, 0o755)

    await expect(engine.start(startRequest(repo, 'solo', { prompt }))).rejects.toThrow(
      /could not be set up[\s\S]*no dependencies here/
    )
    // Refused at kickoff, so there is no record of a run and no session was
    // ever started.
    expect(engine.runs()).toHaveLength(0)

    // And with a script that works, the node finds what it left behind.
    writeFileSync(script, '#!/usr/bin/env bash\necho ready > .set-up\n', 'utf8')
    chmodSync(script, 0o755)
    const run = await engine.start(startRequest(repo, 'solo', { prompt }))
    await until(() => engine.runs()[0].status === 'complete')
    expect(readFileSync(join(run.worktreePath ?? '', '.set-up'), 'utf8').trim()).toBe('ready')
  })

  // Quitting is the only way a record outlives the engine that was writing
  // it: dispose() cannot outlive the process, so whatever it was mid-sentence
  // about is still on disk saying "running" when the next launch reads it.
  it('lays to rest the runs a previous launch left mid-flight', () => {
    const stateDir = tempDir('crucible-engine-relaunch-')
    const store = createRunStore(stateDir)
    store.save({
      id: 'aa11',
      workflow: 'solo',
      status: 'running',
      workspacePath: '/somewhere',
      workspaceName: 'somewhere',
      sessionId: 'orchestrator-1',
      waiting: true,
      question: { reason: 'is this right?', nodeId: 'work', raisedAt: '2026-01-01T00:00:00.000Z' },
      inputs: {},
      nodes: [
        { id: 'done', status: 'complete', parents: [], reads: [], artifacts: [] },
        { id: 'work', status: 'blocked', parents: [], reads: [], artifacts: [], now: 'thinking…' },
        { id: 'later', status: 'pending', parents: ['work'], reads: [], artifacts: [] }
      ],
      createdAt: '2026-01-01T00:00:00.000Z'
    })

    const engine = createWorkflowEngine({
      loader: loaderOf({}),
      store,
      sessions: scriptedSessions(() => () => {}),
      deliver: () => {},
      onChanged: () => {}
    })

    const [run] = engine.runs()
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/quit while this run was working/)
    expect(run.endedAt).toBeDefined()
    // Nothing is owed an answer any more, and nothing claims to be thinking.
    expect(run.waiting).toBe(false)
    expect(run.question).toBeUndefined()
    expect(run.nodes.map((node) => node.status)).toEqual(['complete', 'failed', 'pending'])
    expect(run.nodes[1].now).toBeUndefined()
    // Written through, so the next launch reads the settled record.
    expect(store.load()[0].status).toBe('failed')

    // And it is a record, not a ghost: the live-only operations say so
    // plainly rather than pretending to work.
    expect(() => engine.cancel('aa11')).toThrow(/not live/)
  })
})

// A node states what it follows, and the record is where the run graph reads
// it. Everything below is about one moment: what parents the engine writes
// when a node starts.
describe('what the record says a node follows', () => {
  /** A node whose only work is to claim it is done. */
  const idle: NodeScript = (_prompt, tools) => tools.complete({ summary: 'done' })

  const declaring: WorkflowDef = {
    description: 'declares its own edges, and reads one file besides',
    inputs: { prompt: 'the task file' },
    plan: (): PlannedNode[] => [
      { id: 'alpha', outputs: { note: { file: 'alpha.md', desc: 'a note' } } },
      { id: 'beta', parents: ['alpha'] },
      { id: 'gamma', parents: ['alpha'] },
      { id: 'delta', parents: ['beta'] }
    ],
    run: async (ctx) => {
      const alpha = await ctx.node('alpha', {
        prompt: 'write the note',
        outputs: { note: { file: 'alpha.md', desc: 'a note' } }
      })
      // Declares nothing: the plan said what it follows and that stands.
      await ctx.node('beta', { prompt: 'follow alpha' })
      // Declares something else: the spec wins over the plan's forecast.
      await ctx.node('gamma', { prompt: 'follow beta', from: ['beta'] })
      // Declared and inferred together, plus an id naming nothing.
      await ctx.node('delta', {
        prompt: 'follow gamma, and read what alpha wrote',
        from: ['gamma', 'nobody-by-that-name'],
        reads: [alpha.outputs.note]
      })
      // Neither declaration nor a read anyone produced: a root, and the
      // stray root is the point — no edge is invented from running last.
      await ctx.node('epsilon', { prompt: 'follow nothing' })
    }
  }

  it('keeps the plan’s parents, lets a spec replace them, and adds what dataflow reveals', async () => {
    const { engine, repo } = rig({ declaring }, (nodeId) =>
      nodeId !== 'alpha'
        ? idle
        : (prompt, tools) => {
            writeFileSync(outputPath(prompt, 'alpha.md'), 'the note\n')
            tools.complete({ summary: 'wrote the note' })
          }
    )
    const task = join(repo, 'task.md')
    writeFileSync(task, 'the task\n')
    await engine.start(startRequest(repo, 'declaring', { prompt: task }))
    await until(() => engine.runs()[0].status === 'complete')

    const parents = Object.fromEntries(
      engine.runs()[0].nodes.map((node) => [node.id, node.parents])
    )
    expect(parents).toEqual({
      alpha: [],
      // The plan declared it and the node starting did not erase it.
      beta: ['alpha'],
      // The spec replaces the forecast rather than unioning with it.
      gamma: ['beta'],
      // Declared first, then what reading alpha's file revealed; the id
      // naming no node is dropped the way revise() drops one.
      delta: ['gamma', 'alpha'],
      epsilon: []
    })
  })

  it('never erases a declared edge because the node read nothing', async () => {
    const noPlan: WorkflowDef = {
      description: 'declares edges with no plan behind them',
      inputs: {},
      run: async (ctx) => {
        await ctx.node('first', { prompt: 'go' })
        await ctx.node('second', { prompt: 'go', from: ['first'] })
        await ctx.node('third', { prompt: 'go', from: ['first', 'second'] })
      }
    }
    const { engine, repo } = rig({ noPlan }, () => idle)
    await engine.start(startRequest(repo, 'noPlan', {}))
    await until(() => engine.runs()[0].status === 'complete')

    expect(engine.runs()[0].nodes.map((node) => node.parents)).toEqual([
      [],
      ['first'],
      ['first', 'second']
    ])
  })

  it('keeps a parent that is still a ghost, so the edge is drawn before it is walked', async () => {
    const aheadOfItself: WorkflowDef = {
      description: 'follows a node the plan has forecast but nobody has started',
      inputs: {},
      plan: (): PlannedNode[] => [{ id: 'later' }, { id: 'omega', parents: ['later'] }],
      run: async (ctx) => {
        await ctx.node('omega', { prompt: 'go', from: ['later'] })
        await ctx.node('later', { prompt: 'go' })
      }
    }
    // Omega stays mid-turn until the test has read the record, so what is
    // asserted is the moment its parent is still a ghost.
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { engine, repo } = rig({ aheadOfItself }, (nodeId) =>
      nodeId !== 'omega'
        ? idle
        : async (_prompt, tools) => {
            await held
            tools.complete({ summary: 'done' })
          }
    )
    await engine.start(startRequest(repo, 'aheadOfItself', {}))

    // While `later` is still a ghost, the node that follows it already names
    // it: the record holds it, so the edge exists to draw.
    await until(() =>
      engine.runs()[0].nodes.some((node) => node.id === 'omega' && node.status === 'running')
    )
    expect(engine.runs()[0].nodes.find((node) => node.id === 'later')?.status).toBe('pending')
    expect(engine.runs()[0].nodes.find((node) => node.id === 'omega')?.parents).toEqual(['later'])

    release?.()
    await until(() => engine.runs()[0].status === 'complete')
    expect(engine.runs()[0].nodes.find((node) => node.id === 'omega')?.parents).toEqual(['later'])
  })

  it('chains a revision after the tip and the nodes that sent it back', async () => {
    const revising: WorkflowDef = {
      description: 'holds a node open and revises it',
      inputs: {},
      run: async (ctx) => {
        await ctx.node('reviewer', { prompt: 'judge it' })
        const held = await ctx.openNode('writer', { prompt: 'write it', from: ['reviewer'] })
        await held.revise('again, with the finding fixed', {
          from: ['reviewer', 'nobody-by-that-name']
        })
        held.close()
      }
    }
    const { engine, repo } = rig({ revising }, () => idle)
    await engine.start(startRequest(repo, 'revising', {}))
    await until(() => engine.runs()[0].status === 'complete')

    const nodes = engine.runs()[0].nodes
    expect(nodes.map((node) => node.id)).toEqual(['reviewer', 'writer', 'writer·r1'])
    expect(nodes[1].parents).toEqual(['reviewer'])
    // The current tip, then whoever sent it back; a name nobody answers to is
    // dropped rather than drawn to nothing.
    expect(nodes[2].parents).toEqual(['writer', 'reviewer'])
  })
})

// The artifact rail draws from the record alone, so what the record says
// about a declared file — before, during and after it lands — is engine
// behavior and tested here.
describe('what the record says about artifacts', () => {
  const twoNodes: WorkflowDef = {
    description: 'a node that works a while, then one that follows it',
    inputs: { prompt: 'the task file' },
    plan: (): PlannedNode[] => [
      { id: 'work', outputs: { report: { file: 'report.md', desc: 'what happened' } } },
      {
        id: 'after',
        parents: ['work'],
        outputs: { summary: { file: 'summary.md', desc: 'the gist' } }
      }
    ],
    run: async (ctx) => {
      await ctx.node('work', {
        prompt: 'do the thing',
        reads: [ctx.inputs.prompt],
        outputs: {
          report: { file: 'report.md', desc: 'what happened' },
          notes: { file: 'notes.md', desc: 'what was learned' }
        }
      })
      await ctx.node('after', {
        prompt: 'sum it up',
        outputs: { summary: { file: 'summary.md', desc: 'the gist' } }
      })
    }
  }

  /** A rig whose first node stays mid-turn until the test lets it finish. */
  function heldRig(): { rig: Rig; release: () => void } {
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const built = rig({ two: twoNodes }, (nodeId) => {
      if (nodeId !== 'work') {
        return (prompt, tools) => {
          writeFileSync(outputPath(prompt, 'summary.md'), 'the gist\n')
          tools.complete({ summary: 'summed up' })
        }
      }
      return async (prompt, tools) => {
        // The report lands early, the notes only at the end: one node with
        // two outputs is how a half-written node is observable at all.
        writeFileSync(outputPath(prompt, 'report.md'), 'the report\n')
        tools.activity('writing the notes…')
        await held
        writeFileSync(outputPath(prompt, 'notes.md'), 'the notes\n')
        tools.complete({ summary: 'did the thing' })
      }
    })
    return { rig: built, release: () => release?.() }
  }

  it('declares what a node will write, on the plan\u2019s ghost and again at start', async () => {
    const { rig: built, release } = heldRig()
    const { engine, repo } = built
    const task = join(repo, 'task.md')
    writeFileSync(task, 'the task\n')
    const started = await engine.start(startRequest(repo, 'two', { prompt: task }))

    await until(() => engine.runs()[0].nodes[0].status === 'running')
    const run = engine.runs()[0]

    // The ghost of the node that has not started names the file it will write,
    // resolved under the run's artifact directory, and calls it unwritten.
    const ghost = run.nodes[1]
    expect(ghost.status).toBe('pending')
    expect(ghost.artifacts.map((artifact) => artifact.name)).toEqual(['summary'])
    expect(ghost.artifacts[0].path).toBe(join(stateDirOf(run.id, built), 'summary.md'))
    expect(ghost.artifacts[0].writtenAt).toBeUndefined()

    // The started node carries its spec's outputs — both of them — from the
    // first moment, rather than only once it has validated.
    const working = run.nodes[0]
    expect(working.artifacts.map((artifact) => artifact.name)).toEqual(['report', 'notes'])
    expect(working.artifacts[1].writtenAt).toBeUndefined()
    expect(working.reads.map((read) => read.path)).toEqual([task])
    // The workflow's inputs are described on the record, for the rail's rows.
    expect(started.inputDescs).toEqual({ prompt: 'the task file' })

    release()
    await until(() => engine.runs()[0].status === 'complete')
  })

  it('stamps an output the moment it lands, without waiting for the node to finish', async () => {
    const { rig: built, release } = heldRig()
    const { engine, repo } = built
    const task = join(repo, 'task.md')
    writeFileSync(task, 'the task\n')
    await engine.start(startRequest(repo, 'two', { prompt: task }))

    await until(() => engine.runs()[0].nodes[0].artifacts[0]?.writtenAt !== undefined)
    const mid = engine.runs()[0].nodes[0]
    expect(mid.status).toBe('running')
    expect(mid.artifacts[1].writtenAt).toBeUndefined()

    const stamped = mid.artifacts[0].writtenAt
    release()
    await until(() => engine.runs()[0].status === 'complete')
    const done = engine.runs()[0].nodes[0]
    // A stamp is the first observation, never the last write.
    expect(done.artifacts[0].writtenAt).toBe(stamped)
    expect(done.artifacts[1].writtenAt).toBeDefined()
    for (const artifact of done.artifacts) {
      expect(readFileSync(artifact.path, 'utf8')).not.toBe('')
    }
  })

  it('leaves a failed node holding the row for what it never wrote', async () => {
    const { engine, repo } = rig({ two: twoNodes }, () => {
      return (_prompt, tools) => {
        // Claims done without writing anything, every time.
        tools.complete({ summary: 'nothing to show' })
      }
    })
    const task = join(repo, 'task.md')
    writeFileSync(task, 'the task\n')
    await engine.start(startRequest(repo, 'two', { prompt: task }))

    await until(() => engine.runs()[0].status === 'failed')
    const node = engine.runs()[0].nodes[0]
    expect(node.status).toBe('failed')
    expect(node.artifacts.map((artifact) => artifact.name)).toEqual(['report', 'notes'])
    expect(node.artifacts.every((artifact) => artifact.writtenAt === undefined)).toBe(true)
  })
})

// Clearing a run and handing it to another session: the two acts ⌘R offers
// on a run that is asking for attention nobody is left to give.
describe('dismissing and adopting a run', () => {
  /** A run taken to completion: settled, so dismissable. */
  async function finishedRun(): Promise<Rig> {
    const built = rig({ solo: oneNode }, () => {
      return (prompt, tools) => {
        writeFileSync(outputPath(prompt, 'report.md'), 'the report\n')
        tools.complete({ summary: 'did the thing' })
      }
    })
    const task = join(built.repo, 'task.md')
    writeFileSync(task, 'the task\n')
    await built.engine.start(startRequest(built.repo, 'solo', { prompt: task }))
    await until(() => built.engine.runs()[0].status === 'complete')
    return built
  }

  it('refuses to dismiss a run that is still working', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { engine, repo } = rig({ solo: oneNode }, () => {
      return async (prompt, tools) => {
        await held
        writeFileSync(outputPath(prompt, 'report.md'), 'late\n')
        tools.complete({ summary: 'done at last' })
      }
    })
    const task = join(repo, 'task.md')
    writeFileSync(task, 'the task\n')
    const started = await engine.start(startRequest(repo, 'solo', { prompt: task }))

    expect(() => engine.dismiss(started.id)).toThrow(/still working/)
    expect(engine.runs()[0].dismissedAt).toBeUndefined()

    release()
    await until(() => engine.runs()[0].status === 'complete')
  })

  it('stamps a settled run once, and the stamp outlives the launch', async () => {
    const { engine, stateDir } = await finishedRun()
    const runId = engine.runs()[0].id

    engine.dismiss(runId)
    const stamped = engine.runs()[0].dismissedAt
    expect(stamped).toBeDefined()

    // Dismissing again says nothing new: the first stamp stands.
    engine.dismiss(runId)
    expect(engine.runs()[0].dismissedAt).toBe(stamped)
    // And nothing else about the run moved.
    expect(engine.runs()[0].status).toBe('complete')
    expect(existsSync(engine.runs()[0].worktreePath ?? '')).toBe(true)

    const reloaded = createRunStore(stateDir).load()
    expect(reloaded[0].dismissedAt).toBe(stamped)
  })

  it('hands a live run to another session, and its next messages follow', async () => {
    const { engine, repo, delivered } = rig({ solo: oneNode }, () => {
      return (_prompt, tools, turn) => {
        if (turn === 1) {
          tools.block({ reason: 'nobody is left to ask' })
          return
        }
        writeFileSync(outputPath(tools.taskPrompt, 'report.md'), 'fixed\n')
        tools.complete({ summary: 'done after help' })
      }
    })
    const task = join(repo, 'task.md')
    writeFileSync(task, 'the task\n')
    const started = await engine.start(startRequest(repo, 'solo', { prompt: task }))
    await until(() => engine.runs()[0].waiting === true)

    // The blocker was already sent, and it stays where it landed.
    expect(delivered.at(-1)?.sessionId).toBe('orchestrator-1')
    const alreadySent = delivered.length

    engine.adopt(started.id, 'investigator-9')
    expect(engine.runs()[0].sessionId).toBe('investigator-9')

    // The adopting session answers the question the old orchestrator never
    // could, and the run walks on.
    engine.answer(started.id, 'use the fallback')
    await until(() => engine.runs()[0].status === 'complete')

    const after = delivered.slice(alreadySent)
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((message) => message.sessionId === 'investigator-9')).toBe(true)
    expect(after.at(-1)?.text).toContain('completed')
  })

  it('hands a settled run over too, and writes the new owner down', async () => {
    const { engine, stateDir } = await finishedRun()
    const runId = engine.runs()[0].id

    engine.adopt(runId, 'investigator-9')
    expect(engine.runs()[0].sessionId).toBe('investigator-9')
    expect(createRunStore(stateDir).load()[0].sessionId).toBe('investigator-9')

    // A run already owned by that session is a quiet no-op.
    engine.adopt(runId, 'investigator-9')
    expect(engine.runs()[0].sessionId).toBe('investigator-9')
    expect(() => engine.adopt('nosuchrun', 'investigator-9')).toThrow(/No run is named/)
  })

  it('carries the run directory on every record, backfilling the old ones', async () => {
    const { engine, stateDir } = await finishedRun()
    const runId = engine.runs()[0].id
    expect(engine.runs()[0].dir).toBe(join(stateDir, runId))

    // A record written before the field existed: the store knows where it
    // read it from, so it says so.
    const older = join(stateDir, 'old1')
    mkdirSync(older, { recursive: true })
    writeFileSync(
      join(older, 'run.json'),
      JSON.stringify({
        id: 'old1',
        workflow: 'adhoc',
        status: 'complete',
        workspacePath: '/repos/thing',
        workspaceName: 'thing',
        inputs: {},
        nodes: [],
        createdAt: '2020-01-01T00:00:00.000Z'
      })
    )

    const loaded = createRunStore(stateDir).load()
    expect(loaded.find((run) => run.id === 'old1')?.dir).toBe(older)
    expect(loaded.find((run) => run.id === runId)?.dir).toBe(join(stateDir, runId))
  })
})

// A run a schedule fired has no orchestrator until a session adopts it (ADR
// 0023). What that means to the engine is here: it delivers nothing, it
// parks rather than speaking, and dismissing it is the whole act.
describe('a run with no orchestrator', () => {
  /** A scheduled fire: no session, no inputs, the scheduled marker. */
  function scheduledRequest(repo: string, workflow: string): {
    workspacePath: string
    workspaceName: string
    workflow: string
    inputs: Record<string, string>
    base: string
    scheduled: true
  } {
    return {
      workspacePath: repo,
      workspaceName: 'engine-test',
      workflow,
      inputs: {},
      base: 'HEAD',
      scheduled: true
    }
  }

  const noInputs: WorkflowDef = {
    description: 'one node, nothing handed in',
    inputs: {},
    plan: () => [{ id: 'work' }],
    run: async (ctx) => {
      const result = await ctx.node('work', {
        prompt: 'do the thing',
        outputs: { report: { file: 'report.md', desc: 'what happened' } }
      })
      return { summary: result.summary }
    }
  }

  it('parks on a blocker with nothing delivered anywhere', async () => {
    const { engine, repo, delivered } = rig({ solo: noInputs }, () => (_prompt, tools, turn) => {
      if (turn === 1) {
        tools.block({ reason: 'the labels force one or the other' })
        return
      }
      writeFileSync(outputPath(tools.taskPrompt, 'report.md'), 'after the answer\n')
      tools.complete({ summary: 'done once somebody answered' })
    })

    const started = await engine.start(scheduledRequest(repo, 'solo'))
    await until(() => engine.runs()[0].waiting === true)

    const parked = engine.runs()[0]
    expect(parked.scheduled).toBe(true)
    expect(parked.sessionId).toBeUndefined()
    expect(parked.question?.reason).toContain('the labels force one or the other')
    expect(parked.nodes[0].status).toBe('blocked')
    // Nobody was told: a run with no orchestrator has no voice at all.
    expect(delivered).toEqual([])

    // It waits indefinitely at no cost until a session takes it on.
    engine.adopt(started.id, 'investigator-9')
    expect(engine.runs()[0].sessionId).toBe('investigator-9')
    engine.answer(started.id, 'default to bug')
    await until(() => engine.runs()[0].status === 'complete')
    expect(delivered.every((message) => message.sessionId === 'investigator-9')).toBe(true)
  })

  it('parks on a failure, and keeps the marker across the store', async () => {
    const { engine, repo, stateDir, delivered } = rig({ solo: noInputs }, () => () => {
      throw new Error('the node blew up')
    })

    await engine.start(scheduledRequest(repo, 'solo'))
    await until(() => engine.runs()[0].status === 'failed')

    expect(delivered).toEqual([])
    const reloaded = createRunStore(stateDir).load()[0]
    expect(reloaded.scheduled).toBe(true)
    expect(reloaded.sessionId).toBeUndefined()
    expect(reloaded.status).toBe('failed')
  })

  it('never carries the marker on a run an agent started', async () => {
    const { engine, repo } = rig({ solo: oneNode }, () => (prompt, tools) => {
      writeFileSync(outputPath(prompt, 'report.md'), 'the report\n')
      tools.complete({ summary: 'did the thing' })
    })
    const task = join(repo, 'task.md')
    writeFileSync(task, 'the task\n')

    await engine.start(startRequest(repo, 'solo', { prompt: task }))
    await until(() => engine.runs()[0].status === 'complete')

    expect(engine.runs()[0].scheduled).toBeUndefined()
  })

  it('is cancelled and stamped in one act when it is dismissed', async () => {
    const { engine, repo } = rig({ solo: noInputs }, () => (_prompt, tools) => {
      tools.block({ reason: 'nobody is listening' })
    })
    const started = await engine.start(scheduledRequest(repo, 'solo'))
    await until(() => engine.runs()[0].waiting === true)

    engine.dismiss(started.id)

    expect(engine.runs()[0].dismissedAt).toBeDefined()
    await until(() => engine.runs()[0].status === 'cancelled')
    // The worktree is left exactly where it stands, as every ending leaves it.
    expect(existsSync(engine.runs()[0].worktreePath ?? '')).toBe(true)

    // Dismissing twice still says nothing new.
    const stamped = engine.runs()[0].dismissedAt
    engine.dismiss(started.id)
    expect(engine.runs()[0].dismissedAt).toBe(stamped)
  })
})

/** Where a run's artifacts live, as the store lays them out. */
function stateDirOf(runId: string, built: Rig): string {
  return join(built.stateDir, runId, 'artifacts')
}
