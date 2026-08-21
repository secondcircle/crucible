// @vitest-environment node
//
// The built-ins Crucible ships, loaded the way the app loads them: the real
// folder, the real jiti loader, the real `crucible:workflow` alias. Nothing
// else covers these two files at runtime — typechecking sees them, but a
// broken alias or a default export that is not a workflow would only ever
// surface as a failed kickoff in front of a human.
//
// No SDK session is constructed and no model is called: loading a workflow
// is reading a file.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { shippedWorkflowLibPath, shippedWorkflowsPath } from '../shipped'
import type { NodeSpec, RunContext } from './authoring'
import { createWorkflowLoader } from './loader'

const APP = join(import.meta.dirname, '..', '..', '..')

const cleanUp: string[] = []

afterEach(() => {
  for (const dir of cleanUp.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A user folder that exists nowhere, so only the built-ins are found. */
const NO_USER_FOLDER = join(APP, 'resources', 'workflows', 'no-such-user-folder')

function shippedLoader(): ReturnType<typeof createWorkflowLoader> {
  return createWorkflowLoader({
    roots: { builtIn: shippedWorkflowsPath(APP), user: NO_USER_FOLDER },
    authoringModule: shippedWorkflowLibPath(APP),
    onUnloadable: (path, cause) => {
      throw new Error(`${path} did not load: ${String(cause)}`)
    }
  })
}

describe('the workflows Crucible ships', () => {
  it('all load, and each says what it is and what it needs', async () => {
    // A workspace with no workflow folder of its own: the built-ins stand alone.
    const listed = await shippedLoader().list(APP)

    expect(listed.map((workflow) => workflow.name)).toEqual(['adhoc', 'build'])
    for (const workflow of listed) {
      expect(workflow.origin).toBe('built-in')
      expect(workflow.def.description.trim()).not.toBe('')
      // Every input is described, because the description is all an
      // orchestrator has to go on when it fills one in.
      for (const [name, described] of Object.entries(workflow.def.inputs)) {
        expect(described.trim(), `${workflow.name}.${name}`).not.toBe('')
      }
    }
  })

  it('plans a graph from its inputs before anything costs money', async () => {
    const loader = shippedLoader()

    const adhoc = await loader.resolve(APP, 'adhoc')
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

    // The plan is what the run view draws as pending ghosts, so its parents
    // have to name nodes the plan itself declares.
    const build = await loader.resolve(APP, 'build')
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
      'builder<-planner',
      'review-1<-builder',
      'gate-alignment-1<-review-1',
      'gate-comments-1<-gate-alignment-1',
      'gate-verdict-1<-gate-alignment-1,gate-comments-1'
    ])
    for (const conditional of ['gate-fixer-1', 'gate-alignment-2', 'fixer-1', 'review-2']) {
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
    const adhoc = await shippedLoader().resolve(APP, 'adhoc')
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

  it('says which workflow a name misses', async () => {
    await expect(shippedLoader().resolve(APP, 'nonesuch')).rejects.toThrow(
      /Known workflows: adhoc, build/
    )
  })
})
