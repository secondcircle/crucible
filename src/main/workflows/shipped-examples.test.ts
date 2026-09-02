// @vitest-environment node
//
// The example workflows Crucible ships beside the agent docs, loaded through
// the real jiti loader and the real `crucible:workflow` alias. The app never
// loads these files — they exist to be copied into a workflow folder — so a
// broken example would otherwise only surface in front of the user who copied
// it. This repo's own `.crucible/workflows/` copies are covered here too,
// loaded the way the app loads them.
//
// No SDK session is constructed and no model is called: loading a workflow
// is reading a file.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { shippedExamplesPath, shippedWorkflowLibPath } from '../shipped'
import type { NodeResult, NodeSpec, RunContext } from './authoring'
import { createWorkflowLoader } from './loader'

const APP = join(import.meta.dirname, '..', '..', '..')

const cleanUp: string[] = []

afterEach(() => {
  for (const dir of cleanUp.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A workspace that exists nowhere, so only the example folder is found. */
const NO_WORKSPACE = join(APP, 'resources', 'agent-docs', 'no-such-workspace')

// The example folder stood up as the loader's user root: the app never reads
// the examples, so the test that keeps them loadable mounts them itself.
function exampleLoader(): ReturnType<typeof createWorkflowLoader> {
  return createWorkflowLoader({
    roots: { user: shippedExamplesPath(APP) },
    authoringModule: shippedWorkflowLibPath(APP),
    onUnloadable: (path, cause) => {
      throw new Error(`${path} did not load: ${String(cause)}`)
    }
  })
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

/** A repository shaped like the worktree a run works in: one commit, no remote. */
function tempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'crucible-adr-audit-repo-'))
  cleanUp.push(repo)
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'test@example.invalid')
  git(repo, 'config', 'user.name', 'Crucible Test')
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'first')
  return repo
}

const subjects = (repo: string): string[] => git(repo, 'log', '--format=%s').split('\n')

interface AdrAuditRun {
  readonly dispatched: readonly (NodeSpec & { id: string })[]
  readonly outputs: unknown
  readonly artifactDir: string
  /** Per node id: the subject of the last commit, and the dirt, as it found them. */
  readonly headAt: Record<string, string>
  readonly dirtyAt: Record<string, string>
}

/**
 * The shipped adr-audit definition run against scripted nodes and a real
 * repository. `edits` is a node id to one file that node leaves behind, which
 * is what gives the workflow's commits anything to commit.
 */
async function driveAdrAudit(
  repo: string,
  edits: Readonly<Record<string, string>> = {}
): Promise<AdrAuditRun> {
  const artifactDir = mkdtempSync(join(tmpdir(), 'crucible-adr-audit-artifacts-'))
  cleanUp.push(artifactDir)
  const verdicts: Record<string, unknown> = {
    audit: { kept: 11, edited: 3, flagged: 2, deleted: 4 },
    sweep: { removed: 7 }
  }
  const dispatched: (NodeSpec & { id: string })[] = []
  const headAt: Record<string, string> = {}
  const dirtyAt: Record<string, string> = {}

  const adrAudit = await exampleLoader().resolve(NO_WORKSPACE, 'adr-audit')
  const outputs = await adrAudit.def.run({
    inputs: {},
    artifactDir,
    cwd: repo,
    node: async (id: string, spec: NodeSpec): Promise<NodeResult> => {
      dispatched.push({ id, ...spec })
      headAt[id] = git(repo, 'log', '-1', '--format=%s')
      dirtyAt[id] = git(repo, 'status', '--porcelain')
      const written = edits[id]
      if (written !== undefined) {
        mkdirSync(dirname(join(repo, written)), { recursive: true })
        writeFileSync(join(repo, written), `work of ${id}\n`)
      }
      return {
        outputs: Object.fromEntries(
          Object.entries(spec.outputs ?? {}).map(([name, output]) => [
            name,
            join(artifactDir, output.file)
          ])
        ),
        verdict: verdicts[id],
        summary: `scripted ${id}`
      }
    }
  } as unknown as RunContext)

  return { dispatched, outputs, artifactDir, headAt, dirtyAt }
}

describe('the example workflows Crucible ships', () => {
  it('all load, and each says what it is and what it needs', async () => {
    const listed = await exampleLoader().list(NO_WORKSPACE)

    expect(listed.map((workflow) => workflow.name)).toEqual(['adhoc', 'adr-audit', 'build'])

    // The audit is kicked off with nothing at all, so its declaration is what
    // lets `crucible_run` omit inputs for it.
    expect(listed.find((workflow) => workflow.name === 'adr-audit')?.def.inputs).toEqual({})

    for (const workflow of listed) {
      expect(workflow.def.description.trim()).not.toBe('')
      // Every input is described, because the description is all an
      // orchestrator has to go on when it fills one in.
      for (const [name, described] of Object.entries(workflow.def.inputs)) {
        expect(described.trim(), `${workflow.name}.${name}`).not.toBe('')
      }
    }
  })

  // This repository keeps its own copies enrolled, so retiring the built-ins
  // never broke its build path. Loaded exactly as the app would: a user root
  // that finds nothing, this checkout as the workspace.
  it("finds this repo's own workflows at the workspace rung", async () => {
    const loader = createWorkflowLoader({
      roots: { user: NO_WORKSPACE },
      authoringModule: shippedWorkflowLibPath(APP),
      onUnloadable: (path, cause) => {
        throw new Error(`${path} did not load: ${String(cause)}`)
      }
    })
    const listed = await loader.list(APP)
    expect(listed.map((workflow) => [workflow.name, workflow.origin])).toEqual([
      ['adr-audit', 'workspace']
    ])
  })

  it('plans a graph from its inputs before anything costs money', async () => {
    const loader = exampleLoader()

    const adhoc = await loader.resolve(NO_WORKSPACE, 'adhoc')
    expect(adhoc.def.plan?.({ prompt: '/tmp/task.md' })).toEqual([
      {
        id: 'work',
        outputs: {
          report: {
            file: 'report.html',
            desc: "the node's report of what it did and why, for the human"
          }
        }
      }
    ])

    // All three audit nodes are certain to run, so all three are ghosts from
    // kickoff, each already naming the artifact it will write.
    const audit = await loader.resolve(NO_WORKSPACE, 'adr-audit')
    expect(audit.def.plan?.({})).toEqual([
      {
        id: 'audit',
        model: 'anthropic/claude-fable-5:high',
        outputs: {
          findings: {
            file: 'audit-findings.md',
            desc: 'every ADR in the folder, its disposition and the reasoning behind it'
          }
        }
      },
      {
        id: 'sweep',
        model: 'anthropic/claude-fable-5:high',
        parents: ['audit'],
        outputs: {
          findings: {
            file: 'sweep-findings.md',
            desc: 'every citation site the sweep edited, and what stands there now'
          }
        }
      },
      {
        id: 'report',
        model: 'anthropic/claude-fable-5:high',
        parents: ['audit', 'sweep'],
        outputs: {
          report: {
            file: 'report.html',
            desc: 'the run judged in one document, for the human who reads the branch'
          }
        }
      }
    ])

    // The plan is what the run view draws as pending ghosts, so its parents
    // have to name nodes the plan itself declares.
    const build = await loader.resolve(NO_WORKSPACE, 'build')
    const planned = build.def.plan?.({ intent: '/tmp/intent.md' }) ?? []
    expect(planned.length).toBeGreaterThan(0)
    const ids = new Set(planned.map((node) => node.id))
    for (const node of planned) {
      for (const parent of node.parents ?? []) expect(ids.has(parent)).toBe(true)
    }

    // A build ends in the merge gate, so its first round is certain to run
    // and belongs in what a human sees before anything costs money.
    expect(planned.map((node) => `${node.id}<-${(node.parents ?? []).join(',')}`)).toEqual([
      'planner<-',
      'spec-review-1<-planner',
      'builder<-spec-review-1',
      'review-1<-builder',
      'gate-alignment-1<-review-1',
      'gate-comments-1<-gate-alignment-1',
      'gate-verdict-1<-gate-alignment-1,gate-comments-1'
    ])
    for (const conditional of [
      'gate-fixer-1',
      'gate-alignment-2',
      'fixer-1',
      'review-2',
      'spec-fixer-1',
      'spec-review-2'
    ]) {
      expect(ids.has(conditional), 'a conditional node must not haunt the preview').toBe(false)
    }

    // The artifact rail draws expected rows from the plan, so a planned output
    // has to name the file the node's spec will actually write.
    const files = Object.fromEntries(
      planned.map((node) => [
        node.id,
        Object.values(node.outputs ?? {}).map((output) => output.file)
      ])
    )
    expect(files).toEqual({
      planner: ['spec.md'],
      'spec-review-1': ['spec-review-1.md'],
      builder: [],
      'review-1': ['review-1.md'],
      'gate-alignment-1': [],
      'gate-comments-1': [],
      'gate-verdict-1': []
    })
  })

  // adhoc reads the file it was handed and nothing anyone produced, so it is
  // a root; declaring anything would be an invented edge.
  it('leaves adhoc’s one node a root, declaring nothing to follow', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'crucible-adhoc-'))
    cleanUp.push(scratch)
    const prompt = join(scratch, 'task.md')
    writeFileSync(prompt, 'do the thing\n')

    const dispatched: NodeSpec[] = []
    const adhoc = await exampleLoader().resolve(NO_WORKSPACE, 'adhoc')
    await adhoc.def.run({
      inputs: { prompt },
      artifactDir: scratch,
      cwd: scratch,
      node: async (_id: string, spec: NodeSpec) => {
        dispatched.push(spec)
        return { outputs: { report: join(scratch, 'report.html') }, verdict: undefined, summary: '' }
      }
    } as unknown as RunContext)

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].from).toBeUndefined()
    expect(dispatched[0].reads).toEqual([prompt])
  })

  // The audit is judged from its report, so what the run hands back has to
  // carry the report and the counts a human would otherwise go looking for.
  it('walks adr-audit through audit, sweep and report, returning what they found', async () => {
    const repo = tempRepo()
    const run = await driveAdrAudit(repo)

    expect(run.dispatched.map((node) => `${node.id}<-${(node.from ?? []).join(',')}`)).toEqual([
      'audit<-',
      'sweep<-audit',
      'report<-audit,sweep'
    ])
    // The audit takes no inputs and follows nothing: a root says so by
    // declaring neither.
    expect(run.dispatched[0].from).toBeUndefined()
    expect(run.dispatched[0].reads).toBeUndefined()
    expect(run.dispatched[1].reads).toBeUndefined()
    expect(run.dispatched[2].reads).toEqual([
      join(run.artifactDir, 'audit-findings.md'),
      join(run.artifactDir, 'sweep-findings.md')
    ])

    expect(run.outputs).toEqual({
      report: join(run.artifactDir, 'report.html'),
      kept: 11,
      edited: 3,
      flagged: 2,
      deleted: 4,
      citationsRemoved: 7
    })
    // Nobody changed the worktree here, and a run that commits an actor's
    // empty hands leaves a branch whose story is a lie.
    expect(subjects(repo)).toEqual(['first'])
  })

  // The branch is half of what a run leaves behind, and its commits are how a
  // reader tells the audit's edits from the sweep's.
  it('commits what the audit changed and what the sweep changed, in that order', async () => {
    const repo = tempRepo()
    const run = await driveAdrAudit(repo, {
      audit: join('docs', 'adr', 'kept.md'),
      sweep: 'swept.ts'
    })

    expect(subjects(repo)).toEqual(['adr-audit: sweep', 'adr-audit: audit', 'first'])
    // The report only reads, so nothing follows it and it works on a tree the
    // two commits already hold.
    expect(run.headAt.report).toBe('adr-audit: sweep')
    expect(run.dirtyAt.report).toBe('')
  })

  it('says which workflow a name misses', async () => {
    await expect(exampleLoader().resolve(NO_WORKSPACE, 'nonesuch')).rejects.toThrow(
      /Known workflows: adhoc, adr-audit, build/
    )
  })
})
