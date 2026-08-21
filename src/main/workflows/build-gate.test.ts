// @vitest-environment node
//
// The build workflow's orchestration, driven at the highest seam that runs
// the real code: the shipped definition, resolved through the real loader,
// with its run() handed a scripted context and a real git repository. The
// gate is sequencing, per-actor commits, a refusal counter, a check-in
// cadence and a merge test that must mutate nothing — none of it observable
// anywhere else short of a paid run.
//
// No SDK session is constructed and no model is called: every node's answer
// is scripted, and what these tests assert is what the workflow did with it.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { shippedWorkflowLibPath, shippedWorkflowsPath } from '../shipped'
import type { NodeResult, NodeSpec, RunContext, WorkflowDef } from './authoring'
import { createWorkflowLoader } from './loader'

const APP = join(import.meta.dirname, '..', '..', '..')

/** The doctrine as it must reach the police: an edit here is the point. */
const COMMENT_DOCTRINE = `# Comment doctrine

A comment that survives review tells a reader one thing: why something
non-obvious was done. Nothing else earns the space.

Why this matters: code already says what it does, so a comment restating it is
noise at best and, the moment the code moves on, a lie. The comments a review
lets through become the codebase's permanent voice — every one of them is a
claim some future reader will trust.

The constraints:

- A comment never describes what the code does or how; that is the code's
  job. It exists only to explain a decision a reader would otherwise find
  strange.
- A line or two at most. A why that needs more was a real trade-off and
  belongs in an ADR — and once recorded there, the code should read as
  unsurprising on its own.
- A comment references nothing outside the code: no file paths, no documents,
  no ADR numbers, no artifacts of the code's creation. A reference to
  something ephemeral rots; a reference to something durable means the
  explanation lives in the wrong place.`

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

function commitAll(repo: string, message: string): void {
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', message)
}

/** A repository shaped like a run's worktree: a local trunk and a work branch. */
function tempRepo(trunk = 'main'): string {
  const repo = tempDir('crucible-build-repo-')
  git(repo, 'init', '-q', '-b', trunk)
  git(repo, 'config', 'user.email', 'test@example.invalid')
  git(repo, 'config', 'user.name', 'Crucible Test')
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  commitAll(repo, 'first')
  git(repo, 'checkout', '-q', '-b', 'crucible/run-test')
  return repo
}

type Verdict = 'approved' | 'changes-required'

interface Script {
  /** What each verdict-bearing node concludes; anything unnamed approves. */
  readonly verdicts?: Readonly<Record<string, Verdict>>
  /** Node id -> a file that node leaves behind in the worktree. */
  readonly edits?: Readonly<Record<string, string>>
  /** What ctx.ask() answers, in order. */
  readonly answers?: readonly string[]
}

interface Dispatch {
  readonly id: string
  readonly prompt: string
  readonly reads: readonly string[]
  readonly model: string | undefined
  /** The tree as the node found it: subject of the last commit, and dirt. */
  readonly head: string
  readonly dirty: string
}

interface Ask {
  readonly reason: string
  readonly artifacts: Readonly<Record<string, string>>
}

interface Driver {
  readonly ctx: RunContext
  /** Node dispatches and check-ins in the order they happened. */
  readonly events: string[]
  readonly nodes: Dispatch[]
  readonly asks: Ask[]
  readonly artifactDir: string
  readonly intent: string
  node(id: string): Dispatch
  prompt(id: string): string
}

function driver(repo: string, script: Script = {}): Driver {
  const artifactDir = tempDir('crucible-build-artifacts-')
  const intentDir = tempDir('crucible-build-intent-')
  const intent = join(intentDir, 'intent.md')
  writeFileSync(intent, '# Intent\n\nWhat this work was agreed to be.\n')

  const events: string[] = []
  const nodes: Dispatch[] = []
  const asks: Ask[] = []
  let answered = 0

  const ctx: RunContext = {
    inputs: { intent },
    artifactDir,
    cwd: repo,
    async node(id: string, spec: NodeSpec): Promise<NodeResult> {
      if (nodes.some((seen) => seen.id === id)) throw new Error(`duplicate node id "${id}"`)
      // The engine refuses a node whose declared input is missing, so the
      // fake does too: a report the workflow lists before it exists is a
      // failure in production, not a detail.
      for (const read of spec.reads ?? []) {
        if (!existsSync(read)) throw new Error(`node "${id}": required input missing: ${read}`)
      }
      events.push(`node:${id}`)
      nodes.push({
        id,
        prompt: spec.prompt,
        reads: [...(spec.reads ?? [])],
        model: spec.model,
        head: git(repo, 'log', '-1', '--format=%s'),
        dirty: git(repo, 'status', '--porcelain')
      })

      const written = script.edits?.[id]
      if (written !== undefined) writeFileSync(join(repo, written), `work of ${id}\n`)

      const outputs: Record<string, string> = {}
      for (const [name, output] of Object.entries(spec.outputs ?? {})) {
        const path = join(artifactDir, output.file)
        writeFileSync(path, `<!doctype html><title>${id}</title>${output.desc}\n`)
        outputs[name] = path
      }
      const verdict =
        spec.verdict === undefined
          ? undefined
          : { verdict: script.verdicts?.[id] ?? 'approved', reason: `scripted ${id}` }
      return { outputs, verdict, summary: `scripted ${id}` }
    },
    openNode: () => {
      throw new Error('the build workflow holds no node open')
    },
    async ask(question): Promise<string> {
      events.push('ask')
      asks.push({ reason: question.reason, artifacts: { ...question.artifacts } })
      answered += 1
      return script.answers?.[answered - 1] ?? `correction ${answered}`
    },
    derive: () => {
      throw new Error('the build workflow derives nothing')
    },
    stage: () => {
      throw new Error('the build workflow stages nothing')
    }
  }

  const found = (id: string): Dispatch => {
    const dispatch = nodes.find((candidate) => candidate.id === id)
    if (dispatch === undefined) throw new Error(`no node "${id}" ran; ran: ${events.join(', ')}`)
    return dispatch
  }
  return {
    ctx,
    events,
    nodes,
    asks,
    artifactDir,
    intent,
    node: found,
    prompt: (id) => found(id).prompt
  }
}

async function buildWorkflow(): Promise<WorkflowDef> {
  const loader = createWorkflowLoader({
    roots: {
      builtIn: shippedWorkflowsPath(APP),
      user: join(APP, 'resources', 'workflows', 'no-such-user-folder')
    },
    authoringModule: shippedWorkflowLibPath(APP)
  })
  return (await loader.resolve(APP, 'build')).def
}

interface Outputs {
  verdict: string
  reason: string
  coverageReport: string
  commentReports: string[]
  merge: { result: string; files?: string[]; why?: string }
}

async function build(repo: string, script: Script = {}): Promise<Driver & { outputs: Outputs }> {
  const rig = driver(repo, script)
  const outputs = (await (await buildWorkflow()).run(rig.ctx)) as unknown as Outputs
  return { ...rig, outputs }
}

/** Refusals for gate rounds 1..n, so round n+1 is the one that approves. */
function gateRefusals(rounds: number): Record<string, Verdict> {
  return Object.fromEntries(
    Array.from({ length: rounds }, (_, at) => [`gate-verdict-${at + 1}`, 'changes-required'])
  )
}

describe('the merge gate, the final phase of a build', () => {
  it('opens on an approved review: alignment, then police, then a verdict on a policed tree', async () => {
    const repo = tempRepo()
    const rig = await build(repo, {
      edits: { builder: 'built.ts', 'gate-comments-1': 'policed.ts' }
    })

    expect(rig.events).toEqual([
      'node:planner',
      'node:builder',
      'node:review-1',
      'node:gate-alignment-1',
      'node:gate-comments-1',
      'node:gate-verdict-1'
    ])

    // The alignment check reads the diff the branch's agents left, before the
    // police has touched a comment in it.
    expect(rig.node('gate-alignment-1').head).toBe('build: builder')
    expect(rig.node('gate-comments-1').head).toBe('build: builder')

    // The verdict judges a tree the comment fixes are already part of.
    expect(rig.node('gate-verdict-1').head).toBe('build: comment police 1')
    expect(rig.node('gate-verdict-1').dirty).toBe('')

    // Judging runs on the document model; only the fixer writes code.
    for (const id of ['gate-alignment-1', 'gate-comments-1', 'gate-verdict-1']) {
      expect(rig.node(id).model).toBe('anthropic/claude-fable-5:high')
    }
  })

  it('commits nothing for a round that changed nothing', async () => {
    const repo = tempRepo()
    const rig = await build(repo)

    expect(rig.node('gate-verdict-1').head).toBe('first')
    expect(git(repo, 'rev-list', '--count', 'HEAD')).toBe('1')
  })

  it('refusal dispatches a fixer, commits its work, and starts a whole new round', async () => {
    const repo = tempRepo()
    const rig = await build(repo, {
      verdicts: gateRefusals(1),
      edits: { 'gate-fixer-1': 'fixed.ts' }
    })

    expect(rig.events).toEqual([
      'node:planner',
      'node:builder',
      'node:review-1',
      'node:gate-alignment-1',
      'node:gate-comments-1',
      'node:gate-verdict-1',
      'node:gate-fixer-1',
      'node:gate-alignment-2',
      'node:gate-comments-2',
      'node:gate-verdict-2'
    ])
    expect(rig.asks).toEqual([])
    expect(rig.node('gate-fixer-1').model).toBe('anthropic/claude-opus-5:high')
    expect(rig.node('gate-alignment-2').head).toBe('build: gate fixer 1')
    expect(rig.node('gate-alignment-2').dirty).toBe('')

    // Round 2 reads round 1's coverage report, so a persisting finding reads
    // as persisting; the fixer reads every report so far.
    expect(rig.node('gate-alignment-2').reads).toEqual([
      rig.intent,
      join(rig.artifactDir, 'gate-alignment-1.html')
    ])
    expect(rig.node('gate-fixer-1').reads).toEqual([
      rig.intent,
      join(rig.artifactDir, 'spec.md'),
      join(rig.artifactDir, 'gate-alignment-1.html'),
      join(rig.artifactDir, 'gate-comments-1.html')
    ])
  })

  it('parks on the third refusal before dispatching that fixer, and again on the sixth', async () => {
    const repo = tempRepo()
    const rig = await build(repo, { verdicts: gateRefusals(6) })

    // The check-in lands between the verdict and the fixer it dispatches, so
    // the answer reaches the agent it was written for.
    expect(rig.events.filter((event) => event === 'ask' || event.startsWith('node:gate-'))).toEqual(
      [
        ...[1, 2].flatMap((round) => gateRound(round)),
        ...gateRound(3, true),
        ...[4, 5].flatMap((round) => gateRound(round)),
        ...gateRound(6, true),
        'node:gate-alignment-7',
        'node:gate-comments-7',
        'node:gate-verdict-7'
      ]
    )

    expect(rig.asks).toHaveLength(2)
    expect(rig.asks[0].reason).toContain('crucible/run-test')
    expect(rig.asks[0].reason).toContain('3 verdicts in a row')
    expect(rig.asks[1].reason).toContain('6 verdicts in a row')

    // Every report the gate has produced, both kinds, all rounds.
    expect(Object.keys(rig.asks[0].artifacts)).toEqual([
      'intent',
      'gate-alignment-1',
      'gate-alignment-2',
      'gate-alignment-3',
      'gate-comments-1',
      'gate-comments-2',
      'gate-comments-3'
    ])
    expect(Object.keys(rig.asks[1].artifacts)).toHaveLength(13)
    expect(rig.asks[1].artifacts.intent).toBe(rig.intent)
  })

  it('carries gate corrections into every later gate agent, and interior ones into none', async () => {
    const repo = tempRepo()
    const rig = await build(repo, {
      verdicts: {
        'review-1': 'changes-required',
        'review-2': 'changes-required',
        'review-3': 'changes-required',
        ...gateRefusals(3)
      },
      answers: ['INTERIOR RULING: keep going', 'GATE RULING: stop flagging the log format']
    })

    // The interior correction reaches the agent it was written for.
    expect(rig.prompt('fixer-3')).toContain('INTERIOR RULING')

    // Interior rulings judge method against the Spec; the gate answers to the
    // intent document, so neither list reaches the other.
    for (const dispatch of rig.nodes.filter((node) => node.id.startsWith('gate-'))) {
      expect(dispatch.prompt, dispatch.id).not.toContain('INTERIOR RULING')
    }
    for (const id of ['gate-alignment-1', 'gate-alignment-3', 'gate-verdict-3']) {
      expect(rig.prompt(id)).not.toContain('GATE RULING')
    }
    for (const id of [
      'gate-fixer-3',
      'gate-alignment-4',
      'gate-comments-4',
      'gate-verdict-4'
    ]) {
      expect(rig.prompt(id), id).toContain('GATE RULING: stop flagging the log format')
    }
  })

  it('returns the verdict, the final coverage report, every comment report, and the merge result', async () => {
    const repo = tempRepo()
    const rig = await build(repo, { verdicts: gateRefusals(1) })

    expect(rig.outputs).toEqual({
      verdict: 'approved',
      reason: 'scripted gate-verdict-2',
      coverageReport: join(rig.artifactDir, 'gate-alignment-2.html'),
      commentReports: [
        join(rig.artifactDir, 'gate-comments-1.html'),
        join(rig.artifactDir, 'gate-comments-2.html')
      ],
      merge: { result: 'clean' }
    })
  })
})

describe('the merge-cleanliness test', () => {
  function snapshot(repo: string): Record<string, string> {
    return {
      refs: git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
      head: git(repo, 'rev-parse', 'HEAD'),
      history: git(repo, 'log', '--format=%H %s', '--all'),
      status: git(repo, 'status', '--porcelain')
    }
  }

  it('names the conflicting files and leaves the branch exactly as it was', async () => {
    const repo = tempRepo()
    writeFileSync(join(repo, 'README.md'), 'the branch says this\n')
    commitAll(repo, 'branch work')
    git(repo, 'checkout', '-q', 'main')
    writeFileSync(join(repo, 'README.md'), 'the trunk says this\n')
    commitAll(repo, 'trunk work')
    git(repo, 'checkout', '-q', 'crucible/run-test')

    const before = snapshot(repo)
    const rig = await build(repo)

    expect(rig.outputs.merge).toEqual({ result: 'conflicts', files: ['README.md'] })
    // Information, no mutation: no merge commit, no moved ref, no dirt.
    expect(snapshot(repo)).toEqual(before)
  })

  it('completes anyway when the test itself cannot run, saying so and why', async () => {
    // A branch sharing no history with the trunk is one merge-tree refuses to
    // answer for; so is a git too old to have --write-tree. An approved
    // branch is never failed over a diagnostic.
    const repo = tempRepo()
    git(repo, 'checkout', '-q', '--orphan', 'crucible/unrelated')
    writeFileSync(join(repo, 'own-root.md'), 'a history of its own\n')
    commitAll(repo, 'unrelated root')

    const before = snapshot(repo)
    const rig = await build(repo)

    expect(rig.outputs.verdict).toBe('approved')
    expect(rig.outputs.merge.result).toBe('untested')
    expect(rig.outputs.merge.why).toContain('git merge-tree --write-tree')
    expect(rig.outputs.merge.why).toContain('unrelated histories')
    expect(snapshot(repo)).toEqual(before)
  })

  it('reports a clean merge and leaves the branch exactly as it was', async () => {
    const repo = tempRepo()
    writeFileSync(join(repo, 'branch-only.md'), 'nothing the trunk touches\n')
    commitAll(repo, 'branch work')

    const before = snapshot(repo)
    const rig = await build(repo)

    expect(rig.outputs.merge).toEqual({ result: 'clean' })
    expect(snapshot(repo)).toEqual(before)
  })
})

describe('the trunk the gate judges against', () => {
  it('is the local main or master, and no remote is ever consulted', async () => {
    const onMain = tempRepo()
    const onMaster = tempRepo('master')
    expect(git(onMain, 'remote')).toBe('')
    expect(git(onMaster, 'remote')).toBe('')

    const main = await build(onMain)
    const master = await build(onMaster)

    expect(main.prompt('gate-alignment-1')).toContain('git diff main...HEAD')
    expect(master.prompt('gate-alignment-1')).toContain('git diff master...HEAD')
    expect(master.prompt('gate-verdict-1')).toContain('git diff master...HEAD')
    for (const dispatch of [...main.nodes, ...master.nodes]) {
      expect(dispatch.prompt, dispatch.id).not.toContain('origin')
    }
  })
})

describe('what the gate tells its agents', () => {
  it('gives the police the doctrine verbatim and the comments-only limits', async () => {
    const rig = await build(tempRepo())
    const prompt = rig.prompt('gate-comments-1')

    expect(prompt).toContain(COMMENT_DOCTRINE)
    expect(prompt).toContain('Edit comments only.')
    expect(prompt).toContain(
      'No change to code behavior, identifiers, structure, or\n  formatting beyond what editing or removing a comment forces.'
    )
    expect(prompt).toContain('Only comments this branch added or edited.')
    expect(prompt).toContain('You write no ADRs and no documents besides your report.')
    expect(prompt).toContain('dark-mode HTML document')
  })

  it('sends the alignment check after both tiers, the mocks and the acknowledgments', async () => {
    const rig = await build(tempRepo())
    const prompt = rig.prompt('gate-alignment-1')

    expect(prompt).toContain('**Coverage**')
    expect(prompt).toContain('**Scope creep**')
    expect(prompt).toContain('**Incidental extras**')
    expect(prompt).toContain('**Mock fidelity**')
    expect(prompt).toContain('**Acknowledgment**')
    expect(prompt).toContain('the mocks the intent document cites')
    expect(prompt).toContain('every input acknowledges in the same frame it lands')
    expect(prompt).toContain('a defect on par with wrong data')
    expect(prompt).toContain('It is the sole standard')
    expect(prompt).toContain('Review only')
    expect(prompt).toContain('dark-mode HTML document')
  })

  it('demands a closed verdict, actionable without the reports', async () => {
    const rig = await build(tempRepo())
    const prompt = rig.prompt('gate-verdict-1')

    expect(prompt).toContain('`approved` only when nothing in the reports demands action')
    expect(prompt).toContain('never silently resolved')
    expect(prompt).toContain('verify a claim against the tree')
    expect(prompt).toContain('actionable without rereading the reports')
    expect(prompt).toContain('You change no files.')
  })

  it('forbids the gate fixer both reopened decisions and unagreed work', async () => {
    const rig = await build(tempRepo(), { verdicts: gateRefusals(1) })
    const prompt = rig.prompt('gate-fixer-1')

    expect(prompt).toContain('Work the findings and nothing else.')
    expect(prompt).toContain('license work the intent document never agreed to')
    expect(prompt).toContain('the reviews that settled them are closed')
    expect(prompt).toContain('not an opening to reopen it')
    expect(prompt).toContain('Fix causes, not symptoms')
    expect(prompt).toContain('nothing is merged or pushed anywhere')
  })

  it('asks the check-in what a correction may and may not do', async () => {
    const rig = await build(tempRepo(), { verdicts: gateRefusals(3) })
    const reason = rig.asks[0].reason

    expect(reason).toContain('a correction retargets the judgment')
    expect(reason).toContain('It never adds scope\nthe intent document did not agree to')
    expect(reason).toContain('Cancel on the run, never an\nanswer')
    expect(reason).toContain('there is no cap')
  })
})

/** The three nodes of one gate round, and the check-in when one lands. */
function gateRound(round: number, checkIn = false): string[] {
  return [
    `node:gate-alignment-${round}`,
    `node:gate-comments-${round}`,
    `node:gate-verdict-${round}`,
    ...(checkIn ? ['ask'] : []),
    `node:gate-fixer-${round}`
  ]
}
