// @vitest-environment node
//
// A node waiting on a monitor, driven through the engine's own seam with a
// scripted `NodeMonitors`: a node that ends its turn waiting is not quiet, its
// wake starts its next turn, its run says nothing to the orchestrator about
// it, and its monitors end with the node however the node ends.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LostMonitor, MonitorOwner, MonitorScope } from '../../shared/monitors/monitor'
import type { NodeMonitors, NodeWake } from '../../shared/monitors/service'
import type { BoundMonitorTools } from '../../shared/agent/monitor-tools'
import type { WorkflowDef } from './authoring'
import { createMonitorModel } from '../monitors/model'
import { memoryMonitorStore } from '../monitors/store'
import type { CheckResult, CheckRunner } from '../monitors/check-runner'
import {
  cleanupScratch,
  relaunch,
  rig,
  scriptedSessions,
  startRequest,
  until,
  type Rig
} from './testing/engine-rig'

afterEach(cleanupScratch)

type NodeOwner = Extract<MonitorOwner, { kind: 'node' }>

interface ScriptedNodeMonitors extends NodeMonitors {
  /** Nodes that should wait the next time the engine asks, and what they wait on. */
  readonly waits: Map<string, { description: string; since: string }>
  /** What each node's wake resolves with, once a test fires it. */
  wake(nodeId: string, text: string): void
  readonly asked: string[]
  readonly released: MonitorScope[]
  readonly bound: { nodeId: string; cwd: string }[]
  lost: readonly LostMonitor[]
  readonly takenBy: string[]
}

function scriptedMonitors(): ScriptedNodeMonitors {
  const waits = new Map<string, { description: string; since: string }>()
  const parked = new Map<string, (wake: NodeWake) => void>()
  const asked: string[] = []
  const released: MonitorScope[] = []
  const bound: { nodeId: string; cwd: string }[] = []
  const takenBy: string[] = []

  const monitors: ScriptedNodeMonitors = {
    waits,
    asked,
    released,
    bound,
    takenBy,
    lost: [],

    wake(nodeId: string, text: string): void {
      const settle = parked.get(nodeId)
      parked.delete(nodeId)
      waits.delete(nodeId)
      settle?.({ text })
    },

    tools(owner: NodeOwner, cwd: string): BoundMonitorTools {
      bound.push({ nodeId: owner.nodeId, cwd })
      return {
        set: async () => 'set',
        list: async () => 'listed',
        stop: async () => 'stopped'
      }
    },

    wait(owner: NodeOwner) {
      asked.push(owner.nodeId)
      const on = waits.get(owner.nodeId)
      if (on === undefined) return undefined
      return {
        on: { monitorId: `m-${owner.nodeId}`, description: on.description, since: on.since },
        wake: new Promise<NodeWake>((resolve) => parked.set(owner.nodeId, resolve))
      }
    },

    takeLost(owner: NodeOwner): readonly LostMonitor[] {
      takenBy.push(owner.nodeId)
      const held = monitors.lost
      monitors.lost = []
      return held
    },

    release(scope: MonitorScope): void {
      released.push(scope)
      for (const [nodeId, settle] of [...parked]) {
        if (scope.kind === 'node' && scope.nodeId !== nodeId) continue
        parked.delete(nodeId)
        waits.delete(nodeId)
        // A released wait never resolves: the run is over.
        void settle
      }
    }
  }
  return monitors
}

const oneNode: WorkflowDef = {
  description: 'one node that may wait on something',
  inputs: { prompt: 'the task file' },
  plan: () => [{ id: 'work' }],
  run: async (ctx) => {
    const result = await ctx.node('work', {
      prompt: 'do the thing',
      tools: ['read', 'bash'],
      outputs: { report: { file: 'report.md', desc: 'what happened' } }
    })
    return { summary: result.summary }
  }
}

function repoRig(monitors: ScriptedNodeMonitors, turns: (prompt: string) => 'wait' | 'complete'): {
  readonly rig: Rig
  readonly prompts: string[]
} {
  const prompts: string[] = []
  const built = rig(
    { solo: oneNode },
    () => (prompt, tools) => {
      prompts.push(prompt)
      if (turns(prompt) === 'complete') {
        const report = /- (\S+) — report:/.exec(tools.taskPrompt)?.[1]
        if (report !== undefined) writeFileSync(report, 'done\n')
        tools.complete({ summary: 'finished' })
      }
    },
    { monitors }
  )
  return { rig: built, prompts }
}

describe('a node that ends its turn waiting', () => {
  it('is waiting rather than quiet: no nudge, no stall, and the run stays running', async () => {
    const monitors = scriptedMonitors()
    monitors.waits.set('work', {
      description: 'CI on PR #482 to finish',
      since: '2026-09-08T10:00:00.000Z'
    })
    let turn = 0
    const { rig: built, prompts } = repoRig(monitors, () => {
      turn += 1
      return turn === 1 ? 'wait' : 'complete'
    })

    const prompt = join(built.repo, 'task.md')
    writeFileSync(prompt, 'do it\n')
    const run = await built.engine.start(startRequest(built.repo, 'solo', { prompt }))

    await until(() => monitors.asked.length > 0)
    // The record says what it is waiting on, in the monitor's own words, and
    // the node is still running.
    const waiting = built.engine.runs().find((one) => one.id === run.id)
    expect(waiting?.status).toBe('running')
    expect(waiting?.nodes[0].status).toBe('running')
    expect(waiting?.nodes[0].waitingOn).toMatchObject({
      description: 'CI on PR #482 to finish',
      since: '2026-09-08T10:00:00.000Z'
    })
    // Nothing was said to the orchestrator, and no second turn was nudged out
    // of the node.
    expect(built.delivered).toEqual([])
    expect(prompts).toHaveLength(1)

    monitors.wake('work', '⏳ Crucible monitor m-1 — condition met: CI on PR #482 to finish')
    await until(() => built.engine.runs()[0].status === 'complete')

    // The wake is the node's next message, and the wait is gone from the
    // record before anything else is written to it.
    expect(prompts[1]).toContain('condition met')
    expect(built.engine.runs()[0].nodes[0].waitingOn).toBeUndefined()
    // Its whole record of the wait: no message to the orchestrator, ever.
    expect(built.delivered.map((one) => one.text).join('\n')).not.toContain('monitor')
  })

  it('gets the monitor tools whatever tool list its spec declares', async () => {
    const monitors = scriptedMonitors()
    const { rig: built } = repoRig(monitors, () => 'complete')
    const prompt = join(built.repo, 'task.md')
    writeFileSync(prompt, 'do it\n')
    await built.engine.start(startRequest(built.repo, 'solo', { prompt }))
    await until(() => built.engine.runs()[0].status === 'complete')

    // The spec declared `['read', 'bash']` and got its monitor tools all the
    // same, exactly as it got the tools it completes through.
    expect(built.sessions.requests[0].tools).toEqual(['read', 'bash'])
    expect(built.sessions.requests[0].monitors).toBeDefined()
    expect(monitors.bound[0]).toMatchObject({ nodeId: 'work' })
    expect(monitors.bound[0].cwd).toBe(built.engine.runs()[0].worktreePath)
  })

  it('releases its monitors however it ends, saying nothing to anybody', async () => {
    const monitors = scriptedMonitors()
    const { rig: built } = repoRig(monitors, () => 'complete')
    const prompt = join(built.repo, 'task.md')
    writeFileSync(prompt, 'do it\n')
    await built.engine.start(startRequest(built.repo, 'solo', { prompt }))
    await until(() => built.engine.runs()[0].status === 'complete')

    expect(monitors.released).toContainEqual({
      kind: 'node',
      runId: built.engine.runs()[0].id,
      nodeId: 'work'
    })
  })

  it('tells a resumed node what the quit cut down under it', async () => {
    const monitors = scriptedMonitors()
    monitors.lost = [
      {
        description: 'CI on PR #482 to finish',
        command: 'gh pr checks 482',
        waitedMs: 400_000,
        timeoutMs: 1_800_000
      }
    ]
    const { rig: built, prompts } = repoRig(monitors, () => 'complete')
    const prompt = join(built.repo, 'task.md')
    writeFileSync(prompt, 'do it\n')
    await built.engine.start(startRequest(built.repo, 'solo', { prompt }))
    await until(() => built.engine.runs()[0].status === 'complete')

    expect(monitors.takenBy).toEqual(['work'])
    expect(prompts[0]).toContain('CI on PR #482 to finish')
    expect(prompts[0]).toContain('gh pr checks 482')
    expect(prompts[0]).toMatch(/no wake is coming/)
  })
})

describe('a quit that catches a node waiting', () => {
  // A node's monitor does not survive a quit: nothing is checking, no wake is
  // coming, and the record closes with the run's interruption. The record must
  // not go on saying the node is waiting on it — the run view's node header
  // reads `waitingOn` off the record and would show a wait that ended when the
  // process did.
  it('leaves no wait on the record it interrupted', async () => {
    const monitors = scriptedMonitors()
    monitors.waits.set('work', {
      description: 'CI on PR #482 to finish',
      since: '2026-09-08T10:00:00.000Z'
    })
    const { rig: built } = repoRig(monitors, () => 'wait')

    const prompt = join(built.repo, 'task.md')
    writeFileSync(prompt, 'do it\n')
    await built.engine.start(startRequest(built.repo, 'solo', { prompt }))
    await until(() => built.engine.runs()[0].nodes[0].waitingOn !== undefined)

    // The quit: the first engine is abandoned rather than disposed, and a
    // second engine over the same store sweeps what it left.
    const after = relaunch(built, { solo: oneNode }, () => () => {}, {
      monitors: scriptedMonitors()
    })
    const node = after.engine.runs()[0].nodes[0]

    expect(node.status).toBe('interrupted')
    expect(node.waitingOn).toBeUndefined()
  })

  // A node's monitor does not survive a quit, but its *record* has to: the
  // next launch's sweep is the only thing that turns it into the notice a
  // resumed node reads. Releasing the owner at dispose drops the record
  // instead, silently and for good, and the resumed node is never told what it
  // had been waiting on.
  it('leaves the record behind, so a resumed node can be told what it lost', async () => {
    // A check that never lands, so the monitor is still live when the quit
    // catches it.
    const stuck: CheckRunner = {
      run: () => ({ done: new Promise<CheckResult>(() => {}), kill: () => {} })
    }
    const store = memoryMonitorStore()
    const model = createMonitorModel({
      store,
      checks: stuck,
      deliver: async () => 'delivered',
      sessionExists: () => true
    })

    const sessions = scriptedSessions(() => async () => {
      await sessions.requests.at(-1)?.monitors?.set({
        description: 'CI on PR #482 to finish',
        reason: 'so I can pick it up the moment it changes',
        command: 'gh pr checks 482'
      })
    })
    const built = rig({ solo: oneNode }, () => () => {}, {
      monitors: model.nodes,
      sessions
    })

    const prompt = join(built.repo, 'task.md')
    writeFileSync(prompt, 'do it\n')
    const run = await built.engine.start(startRequest(built.repo, 'solo', { prompt }))
    await until(() => built.engine.runs()[0].nodes[0].waitingOn !== undefined)

    // The quit, in the order `will-quit` takes it.
    built.engine.dispose()
    model.dispose()
    await new Promise((resolve) => setTimeout(resolve, 20))

    // The next launch, over the records the last one left.
    const next = createMonitorModel({
      store: memoryMonitorStore(store.current),
      checks: stuck,
      deliver: async () => 'delivered',
      sessionExists: () => true
    })
    expect(next.nodes.takeLost({ kind: 'node', runId: run.id, nodeId: 'work' })).toEqual([
      expect.objectContaining({
        description: 'CI on PR #482 to finish',
        command: 'gh pr checks 482'
      })
    ])
  })
})

describe('a wait inside a paused run', () => {
  it('holds the node until the run is resumed, and the wake is still its next message', async () => {
    const monitors = scriptedMonitors()
    monitors.waits.set('work', {
      description: 'the npm publish to land',
      since: '2026-09-08T10:00:00.000Z'
    })
    let turn = 0
    const { rig: built, prompts } = repoRig(monitors, () => {
      turn += 1
      return turn === 1 ? 'wait' : 'complete'
    })
    const prompt = join(built.repo, 'task.md')
    writeFileSync(prompt, 'do it\n')
    const run = await built.engine.start(startRequest(built.repo, 'solo', { prompt }))

    await until(() => monitors.asked.length > 0)
    built.engine.pause(run.id)
    monitors.wake('work', '⏳ Crucible monitor m-1 — condition met: the npm publish to land')

    // Released into nothing: the node is not prompted while the run is paused.
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(prompts).toHaveLength(1)

    await built.engine.resume(run.id)
    await until(() => built.engine.runs()[0].status === 'complete')
    // And the message it gets is the wake, never the "paused and resumed" text.
    expect(prompts[1]).toContain('condition met')
    expect(prompts[1]).not.toContain('paused by a human')
  })
})
