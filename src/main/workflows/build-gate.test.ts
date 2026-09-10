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
import { shippedExamplesPath, shippedWorkflowLibPath } from '../shipped'
import type { NodeResult, NodeSpec, RunContext, WorkflowDef } from './authoring'
import { loadWorkflowDef } from './testing/load-def'

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
  /** What the node declared it follows, which is what the graph draws. */
  readonly from: readonly string[] | undefined
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
        from: spec.from === undefined ? undefined : [...spec.from],
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
  // The example loaded into this process: the test drives its run() against
  // a scripted context and reads what it asked for.
  return loadWorkflowDef(join(shippedExamplesPath(APP), 'build.ts'), shippedWorkflowLibPath(APP))
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
      'node:spec-review-1',
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
      'node:spec-review-1',
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
      join(rig.artifactDir, 'spec.md'),
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

// The design is judged while it is still a document: the loop between the
// planner and the builder is what keeps a bad representation from being
// built faithfully, and none of its sequencing is observable anywhere else
// short of a paid run.
describe('the design review loop, between the planner and the builder', () => {
  it('refusal dispatches a fresh spec fixer, and the builder follows the review that approved', async () => {
    const rig = await build(tempRepo(), {
      verdicts: { 'spec-review-1': 'changes-required' }
    })

    expect(rig.events.slice(0, 5)).toEqual([
      'node:planner',
      'node:spec-review-1',
      'node:spec-fixer-1',
      'node:spec-review-2',
      'node:builder'
    ])
    // The plan's forecast of spec-review-1 would draw a lying edge; the
    // second round is what the builder actually followed.
    expect(rig.node('builder').from).toEqual(['spec-review-2'])

    // Judging and revising a document both run on the document model.
    expect(rig.node('spec-review-1').model).toBe('anthropic/claude-fable-5:high')
    expect(rig.node('spec-fixer-1').model).toBe('anthropic/claude-fable-5:high')

    // Round 2 reads round 1's review, so a persisting finding reads as
    // persisting; the fixer reads every review so far.
    expect(rig.node('spec-review-2').reads).toEqual([
      rig.intent,
      join(rig.artifactDir, 'spec.md'),
      join(rig.artifactDir, 'spec-review-1.md')
    ])
    expect(rig.node('spec-fixer-1').reads).toEqual([
      rig.intent,
      join(rig.artifactDir, 'spec.md'),
      join(rig.artifactDir, 'spec-review-1.md')
    ])
  })

  it('touches no code: the worktree is exactly as the planner left it when the builder starts', async () => {
    const repo = tempRepo()
    const rig = await build(repo, { verdicts: { 'spec-review-1': 'changes-required' } })

    expect(rig.node('builder').head).toBe('first')
    expect(rig.node('builder').dirty).toBe('')
    expect(git(repo, 'rev-list', '--count', 'HEAD')).toBe('1')
  })

  it('parks on the third refusal before dispatching that fixer, with every design review so far', async () => {
    const rig = await build(tempRepo(), {
      verdicts: {
        'spec-review-1': 'changes-required',
        'spec-review-2': 'changes-required',
        'spec-review-3': 'changes-required'
      }
    })

    expect(rig.events.filter((event) => event === 'ask' || event.startsWith('node:spec-'))).toEqual(
      [
        'node:spec-review-1',
        'node:spec-fixer-1',
        'node:spec-review-2',
        'node:spec-fixer-2',
        'node:spec-review-3',
        'ask',
        'node:spec-fixer-3',
        'node:spec-review-4'
      ]
    )

    expect(rig.asks[0].reason).toContain('design review loop')
    expect(rig.asks[0].reason).toContain('crucible/run-test')
    expect(rig.asks[0].reason).toContain('3 reviews have now come back')
    expect(Object.keys(rig.asks[0].artifacts)).toEqual([
      'intent',
      'spec',
      'spec-review-1',
      'spec-review-2',
      'spec-review-3'
    ])
  })

  it('carries design rulings into every later spec agent, and into no builder, reviewer or gate', async () => {
    const rig = await build(tempRepo(), {
      verdicts: {
        'spec-review-1': 'changes-required',
        'spec-review-2': 'changes-required',
        'spec-review-3': 'changes-required'
      },
      answers: ['DESIGN RULING: one map, keyed by label']
    })

    for (const id of ['spec-fixer-3', 'spec-review-4']) {
      expect(rig.prompt(id), id).toContain('DESIGN RULING')
    }
    for (const dispatch of rig.nodes.filter((node) => !node.id.startsWith('spec-'))) {
      expect(dispatch.prompt, dispatch.id).not.toContain('DESIGN RULING')
    }
  })
})

describe('what the build tells its agents about design', () => {
  it('gives the planner, both loops and the builder the design doctrine verbatim', async () => {
    const rig = await build(tempRepo(), {
      verdicts: { 'spec-review-1': 'changes-required', 'review-1': 'changes-required' }
    })

    for (const id of [
      'planner',
      'spec-review-1',
      'spec-fixer-1',
      'builder',
      'review-1',
      'fixer-1'
    ]) {
      expect(rig.prompt(id), id).toContain('# Design doctrine')
      expect(rig.prompt(id), id).toContain('Invalid states are unrepresentable')
      expect(rig.prompt(id), id).toContain('Structural work is feature work')
    }

    // The gate hears only the structural-work tier, never the doctrine.
    for (const id of ['gate-alignment-1', 'gate-comments-1', 'gate-verdict-1']) {
      expect(rig.prompt(id), id).not.toContain('# Design doctrine')
    }
  })

  it('requires the spec to rule its design, and licenses structural work there alone', async () => {
    const rig = await build(tempRepo())

    expect(rig.prompt('planner')).toContain('The design is settled here')
    expect(rig.prompt('planner')).toContain('says so in one line')
    expect(rig.prompt('spec-review-1')).toContain('`approved` when a builder should')
    expect(rig.prompt('builder')).toContain("Where the Spec's design section rules")
    expect(rig.prompt('gate-alignment-1')).toContain('what *structural work*')
  })
})

// A graph that is right only because the renderer guessed well is not fixed:
// the workflow says what each node follows, including the nodes a plan() can
// never enumerate because a runtime loop gives birth to them.
describe('the edges the build workflow declares', () => {
  it('names a parent for every node the loops produce, and none for the root', async () => {
    const rig = await build(tempRepo(), {
      // One refused review and one refused verdict, so a second round of each
      // loop exists to declare its own edges.
      verdicts: { 'review-1': 'changes-required', ...gateRefusals(1) }
    })

    expect(rig.nodes.map((node) => `${node.id}<-${(node.from ?? []).join(',')}`)).toEqual([
      // The planner takes only the kickoff input, so it is a root and says so
      // by declaring nothing.
      'planner<-',
      'spec-review-1<-planner',
      'builder<-spec-review-1',
      'review-1<-builder',
      'fixer-1<-review-1',
      'review-2<-fixer-1',
      // The gate opens on the review that approved the branch.
      'gate-alignment-1<-review-2',
      'gate-comments-1<-gate-alignment-1',
      'gate-verdict-1<-gate-alignment-1,gate-comments-1',
      'gate-fixer-1<-gate-verdict-1',
      'gate-alignment-2<-gate-fixer-1',
      'gate-comments-2<-gate-alignment-2',
      'gate-verdict-2<-gate-alignment-2,gate-comments-2'
    ])
    expect(rig.node('planner').from).toBeUndefined()

    // Every declared parent is a node this run actually ran.
    const ran = new Set(rig.nodes.map((node) => node.id))
    for (const node of rig.nodes) {
      for (const parent of node.from ?? []) expect(ran.has(parent), parent).toBe(true)
    }
  })

  it('follows the review that approved, whichever round that was', async () => {
    const rig = await build(tempRepo(), {
      verdicts: { 'review-1': 'changes-required', 'review-2': 'changes-required' }
    })

    // The plan's forecast of review-1 would draw a lying edge; the third
    // round is what the gate actually followed.
    expect(rig.node('gate-alignment-1').from).toEqual(['review-3'])
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

  it('sends the alignment check after all three tiers, the mocks and the acknowledgments', async () => {
    const rig = await build(tempRepo())
    const prompt = rig.prompt('gate-alignment-1')

    expect(prompt).toContain('**Coverage**')
    expect(prompt).toContain('**Structural work the Spec ruled**')
    expect(prompt).toContain('**Scope creep**')
    expect(prompt).toContain('**Incidental extras**')
    expect(prompt).toContain('**Mock fidelity**')
    expect(prompt).toContain('**Acknowledgment**')
    expect(prompt).toContain('the mocks the intent document cites')
    expect(prompt).toContain('every input acknowledges in the same frame it lands')
    expect(prompt).toContain('a defect on par with wrong data')
    expect(prompt).toContain('the sole authority on *what feature* was agreed')
    expect(prompt).toContain('never creep and never argued for reverting')
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
