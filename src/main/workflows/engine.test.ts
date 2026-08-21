// @vitest-environment node
//
// The engine against scripted node sessions and a real git repository: the
// node loop, the orchestrator routing and the worktree life all run exactly
// as shipped, with no SDK session anywhere (the seam is the point).
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ObservedCacheMiss } from '../../shared/agent/adapter'
import type { SessionId, TranscriptItem } from '../../shared/agent/port'
import type { CacheRecorder, RecordedCacheMiss } from '../cache/ledger'
import type { PlannedNode, WorkflowDef } from './authoring'
import { createWorkflowEngine, type WorkflowEngine } from './engine'
import type {
  NodeBlocker,
  NodeCompletion,
  NodeSession,
  NodeSessionFactory,
  NodeSessionRequest
} from './node-session'
import type { LoadedWorkflow, WorkflowLoader } from './loader'
import { createRunStore } from './store'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** A real repository with one commit, which is all a run needs to branch. */
function tempRepo(): string {
  const repo = tempDir('crucible-engine-repo-')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.invalid')
  git(repo, 'config', 'user.name', 'Crucible Test')
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'first')
  return repo
}

/** What a scripted node may do on one prompt. */
interface NodeTools {
  readonly complete: (completion: NodeCompletion) => void
  readonly block: (blocker: NodeBlocker) => void
  /** A cache miss on this node's turn, as the SDK factory reports one. */
  readonly cacheMiss: (miss: ObservedCacheMiss) => void
  /** A line of liveness, which is what the engine snapshots the node on. */
  readonly activity: (doing: string) => void
  readonly cwd: string
  // The first prompt of the session, which is the one naming the output
  // paths; later prompts (rejections, blocker answers, shoves) do not.
  readonly taskPrompt: string
}

// A script that returns a promise is a turn still under way, which is how a
// node's record is read while its agent is working.
type NodeScript = (prompt: string, tools: NodeTools, turn: number) => void | Promise<void>

/** The prompt names every output path; a script writes one by its file name. */
function outputPath(prompt: string, file: string): string {
  const line = prompt.split('\n').find((candidate) => candidate.includes(file))
  const match = line === undefined ? null : /- (\S+) —/.exec(line)
  if (match === null) throw new Error(`no output path for ${file} in the prompt`)
  return match[1]
}

function scriptedSessions(
  scriptFor: (nodeId: string) => NodeScript
): NodeSessionFactory & { readonly prompts: string[] } {
  const prompts: string[] = []
  return {
    prompts,
    async start(request: NodeSessionRequest): Promise<NodeSession> {
      const nodeId = /^You are "([^"]+)"/.exec(request.rolePrompt)?.[1] ?? 'unknown'
      const script = scriptFor(nodeId)
      let turn = 0
      let disposed = false
      let taskPrompt = ''
      const activityListeners = new Set<(now: string | undefined) => void>()
      return {
        async prompt(text: string): Promise<void> {
          if (disposed) return
          prompts.push(`${nodeId}: ${text.split('\n')[0]}`)
          turn += 1
          if (turn === 1) taskPrompt = text
          await script(
            text,
            {
              complete: (completion) => request.onComplete(completion),
              block: (blocker) => request.onBlocker(blocker),
              cacheMiss: (miss) => request.onCacheMiss?.(miss),
              activity: (doing) => {
                for (const listener of [...activityListeners]) listener(doing)
              },
              cwd: request.cwd,
              taskPrompt
            },
            turn
          )
        },
        async abort(): Promise<void> {},
        isStreaming: () => false,
        stats: () => ({ toolCalls: turn * 3, cost: turn * 0.25, contextPercent: 10 * turn }),
        transcript: (): readonly TranscriptItem[] => [
          { kind: 'assistant', markdown: `scripted node ${nodeId}, turn ${turn}` }
        ],
        onActivity: (listener) => {
          activityListeners.add(listener)
          return () => activityListeners.delete(listener)
        },
        dispose: () => {
          disposed = true
        }
      }
    }
  }
}

function loaderOf(defs: Record<string, WorkflowDef>): WorkflowLoader {
  function loaded(name: string): LoadedWorkflow {
    const def = defs[name]
    if (def === undefined) throw new Error(`No workflow is named "${name}".`)
    return { name, origin: 'built-in', path: `/shipped/${name}.ts`, def }
  }
  return {
    async list() {
      return Object.keys(defs).map(loaded)
    },
    async resolve(_workspace: string, name: string) {
      return loaded(name)
    }
  }
}

interface Rig {
  readonly engine: WorkflowEngine
  readonly repo: string
  readonly stateDir: string
  readonly delivered: { sessionId: SessionId; text: string }[]
  readonly sessions: ReturnType<typeof scriptedSessions>
  /** Every ledger line the run wrote, in order. */
  readonly recorded: RecordedCacheMiss[]
}

function rig(
  defs: Record<string, WorkflowDef>,
  scriptFor: (nodeId: string) => NodeScript
): Rig {
  const repo = tempRepo()
  const stateDir = tempDir('crucible-engine-state-')
  const delivered: { sessionId: SessionId; text: string }[] = []
  const recorded: RecordedCacheMiss[] = []
  const sessions = scriptedSessions(scriptFor)
  // A stand-in for the ledger: what a run writes is checkable without a file.
  const cache: CacheRecorder = {
    retention: '5m',
    ledgerPath: join(stateDir, 'cache-misses.jsonl'),
    append: async (miss) => {
      recorded.push(miss)
    }
  }
  const engine = createWorkflowEngine({
    loader: loaderOf(defs),
    store: createRunStore(stateDir),
    sessions,
    deliver: (sessionId, text) => delivered.push({ sessionId, text }),
    cache,
    onChanged: () => {},
    pollMs: 5,
    watchdogMs: 60_000,
    quietAbortMs: 600_000,
    releaseWaitMs: 100
  })
  return { engine, repo, stateDir, delivered, sessions, recorded }
}

async function until(what: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms
  while (!what()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function startRequest(repo: string, workflow: string, inputs: Record<string, string>) {
  return {
    workspacePath: repo,
    workspaceName: 'engine-test',
    sessionId: 'orchestrator-1',
    workflow,
    inputs,
    base: 'HEAD'
  }
}

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

/** Where a run's artifacts live, as the store lays them out. */
function stateDirOf(runId: string, built: Rig): string {
  return join(built.stateDir, runId, 'artifacts')
}
