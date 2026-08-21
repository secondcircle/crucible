// @vitest-environment node
//
// The engine against scripted node sessions and a real git repository: the
// node loop, the orchestrator routing and the worktree life all run exactly
// as shipped, with no SDK session anywhere (the seam is the point).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionId, TranscriptItem } from '../../shared/agent/port'
import type { WorkflowDef } from './authoring'
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
  readonly cwd: string
  // The first prompt of the session, which is the one naming the output
  // paths; later prompts (rejections, blocker answers, shoves) do not.
  readonly taskPrompt: string
}

type NodeScript = (prompt: string, tools: NodeTools, turn: number) => void

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
      return {
        async prompt(text: string): Promise<void> {
          if (disposed) return
          prompts.push(`${nodeId}: ${text.split('\n')[0]}`)
          turn += 1
          if (turn === 1) taskPrompt = text
          script(
            text,
            {
              complete: (completion) => request.onComplete(completion),
              block: (blocker) => request.onBlocker(blocker),
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
        onActivity: () => () => {},
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
}

function rig(
  defs: Record<string, WorkflowDef>,
  scriptFor: (nodeId: string) => NodeScript
): Rig {
  const repo = tempRepo()
  const stateDir = tempDir('crucible-engine-state-')
  const delivered: { sessionId: SessionId; text: string }[] = []
  const sessions = scriptedSessions(scriptFor)
  const engine = createWorkflowEngine({
    loader: loaderOf(defs),
    store: createRunStore(stateDir),
    sessions,
    deliver: (sessionId, text) => delivered.push({ sessionId, text }),
    onChanged: () => {},
    pollMs: 5,
    watchdogMs: 60_000,
    quietAbortMs: 600_000,
    releaseWaitMs: 100
  })
  return { engine, repo, stateDir, delivered, sessions }
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
})
