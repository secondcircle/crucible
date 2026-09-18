// @vitest-environment node
//
// Reproduction left by review-1: a node that was clean-restarted to
// completion (`gate·r1` complete) is not replayed on a later resume. The
// replay check for a plain node reads only the base record (`recordOf(id)`),
// which stays `interrupted` forever after a clean restart, so the engine
// falls through to the continue path, reopens the *completed* revision's
// session, prompts it again (a paid turn on finished work), and pushes a
// second record under the same `gate·r1` id. Held-open nodes already use
// `furthestComplete(id)` for this exact question.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PlannedNode, WorkflowDef } from './authoring'
import {
  cleanupScratch,
  outputPath,
  relaunch,
  rig,
  startRequest,
  until,
  type NodeScript
} from './testing/engine-rig'

afterEach(cleanupScratch)

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
      prompt: 'write the spec',
      reads: [ctx.inputs.intent],
      outputs: { spec: { file: 'spec.md', desc: 'the Spec' } }
    })
    const gate = await ctx.node('gate', {
      prompt: 'judge the branch',
      reads: [planned.outputs.spec],
      outputs: { verdict: { file: 'verdict.md', desc: 'the verdict' } }
    })
    const built = await ctx.node('builder', {
      prompt: 'build it',
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

describe('a completed clean-restart revision across a second quit', () => {
  it('is replayed, not run again', async () => {
    // Life 1: planner completes, the gate parks, the app quits.
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

    // Life 2: a clean restart. gate·r1 completes; the builder parks; quit.
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

    // Life 3: a plain resume. The gate's work is done — only the builder
    // should go back to work.
    const third = relaunch(second, { threeStep }, () => (_prompt, tools) => {
      writeFileSync(outputPath(tools.taskPrompt, 'report.md'), 'the report\n')
      tools.complete({ summary: 'built it' })
    })
    await third.engine.resume(started.id)
    await until(() => {
      const run = third.engine.runs()[0]
      return run.status !== 'running' || run.nodes.some((node) => node.id.startsWith('gate·r1·'))
    })
    const run = third.engine.runs()[0]

    // No session was opened for the gate: its completed revision is handed
    // back from the record, exactly as a completed base node is.
    expect(third.sessions.prompts.filter((prompt) => prompt.startsWith('gate'))).toEqual([])
    // One record per id: the completed gate·r1 keeps its summary, ungrown.
    expect(run.nodes.filter((node) => node.id === 'gate·r1')).toHaveLength(1)
    expect(run.nodes.find((node) => node.id === 'gate·r1')?.summary).toBe('judged it fresh')
    expect(run.status).toBe('complete')
  }, 20000)
})
