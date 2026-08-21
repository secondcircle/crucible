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
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { shippedWorkflowLibPath, shippedWorkflowsPath } from '../shipped'
import { createWorkflowLoader } from './loader'

const APP = join(import.meta.dirname, '..', '..', '..')

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
    expect(adhoc.def.plan?.({ prompt: '/tmp/task.md' })).toEqual([{ id: 'work' }])

    // The plan is what the run view draws as pending ghosts, so its parents
    // have to name nodes the plan itself declares.
    const build = await loader.resolve(APP, 'build')
    const planned = build.def.plan?.({ intent: '/tmp/intent.md' }) ?? []
    expect(planned.length).toBeGreaterThan(0)
    const ids = new Set(planned.map((node) => node.id))
    for (const node of planned) {
      for (const parent of node.parents ?? []) expect(ids.has(parent)).toBe(true)
    }
  })

  it('says which workflow a name misses', async () => {
    await expect(shippedLoader().resolve(APP, 'nonesuch')).rejects.toThrow(
      /Known workflows: adhoc, build/
    )
  })
})
