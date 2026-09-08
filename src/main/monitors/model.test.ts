import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId, SystemMessage } from '../../shared/agent/port'
import {
  RETAINED_OUTPUT_CHARS,
  WAKE_OUTPUT_CHARS,
  type MonitorOwner
} from '../../shared/monitors/monitor'
import type { MainMonitorService } from '../../shared/monitors/service'
import { lostMonitorsNotice } from '../../shared/monitors/wording'
import type { CheckResult, CheckRun, CheckRunner } from './check-runner'
import { createMonitorModel, type MonitorRecord } from './model'
import { memoryMonitorStore } from './store'

// The monitor model against a scripted process seam, a pinned clock and fake
// timers: the whole loop — the checks, the three endings, the delivery, the
// sweep across a quit — without a shell, a window or a model.

const SESSION: MonitorOwner = { kind: 'session', sessionId: 's1' }
const OTHER: MonitorOwner = { kind: 'session', sessionId: 's2' }
const NODE: MonitorOwner = { kind: 'node', runId: 'en42', nodeId: 'builder' }

const START = Date.parse('2026-09-08T10:00:00.000Z')

interface Scripted extends CheckRunner {
  /** What every run of a command answers with, in order; the last one repeats. */
  script(command: string, results: readonly CheckResult[]): void
  /** Holds the next run open until `settle` is called. */
  hold(command: string): void
  settle(command: string, result: CheckResult): void
  readonly runs: { command: string; cwd: string }[]
  readonly killed: string[]
}

function scriptedChecks(): Scripted {
  const scripts = new Map<string, CheckResult[]>()
  const holding = new Set<string>()
  const held = new Map<string, (result: CheckResult) => void>()
  const runs: { command: string; cwd: string }[] = []
  const killed: string[] = []

  return {
    runs,
    killed,
    script(command, results) {
      scripts.set(command, [...results])
    },
    hold(command) {
      holding.add(command)
    },
    settle(command, result) {
      const settle = held.get(command)
      held.delete(command)
      settle?.(result)
    },
    run(command: string, cwd: string): CheckRun {
      runs.push({ command, cwd })
      let settle: (result: CheckResult) => void = () => {}
      const done = new Promise<CheckResult>((resolve) => {
        settle = resolve
      })
      if (holding.has(command)) {
        held.set(command, settle)
      } else {
        const queued = scripts.get(command) ?? []
        const next = queued.length > 1 ? (queued.shift() as CheckResult) : queued[0]
        queueMicrotask(() =>
          settle(next ?? { kind: 'exited', exitCode: 1, output: 'waiting', stderr: '' })
        )
      }
      return {
        done,
        kill(): void {
          killed.push(command)
          settle({ kind: 'killed' })
        }
      }
    }
  }
}

interface Rig {
  readonly model: MainMonitorService
  readonly checks: Scripted
  readonly store: ReturnType<typeof memoryMonitorStore>
  readonly delivered: { sessionId: SessionId; message: SystemMessage }[]
  /** Sessions the shell store still holds; a record for anything else is dropped. */
  readonly sessions: Set<string>
  refuseDelivery(on: boolean): void
  now(): number
}

let clock = START

function rigOf(
  records: readonly MonitorRecord[] = [],
  options: { readonly sessions?: readonly string[] } = {}
): Rig {
  const checks = scriptedChecks()
  const store = memoryMonitorStore(records)
  const delivered: { sessionId: SessionId; message: SystemMessage }[] = []
  const sessions = new Set(options.sessions ?? ['s1', 's2'])
  let refusing = false
  let minted = 0

  const model = createMonitorModel({
    store,
    checks,
    deliver: async (sessionId, message) => {
      if (refusing) throw new Error('no shell is up to carry a wake yet')
      if (!sessions.has(sessionId)) return 'no-session'
      delivered.push({ sessionId, message })
      return 'delivered'
    },
    sessionExists: (sessionId) => sessions.has(sessionId),
    now: () => clock,
    mintId: () => {
      minted += 1
      return `m-${minted.toString(16).padStart(4, '0')}`
    }
  })

  return {
    model,
    checks,
    store,
    delivered,
    sessions,
    refuseDelivery(on: boolean): void {
      refusing = on
    },
    now: () => clock
  }
}

/** Moves the clock and the timers together, then lets the promises settle. */
async function tick(ms: number): Promise<void> {
  clock += ms
  await vi.advanceTimersByTimeAsync(ms)
}

/** Lets whatever is already scheduled at this instant run. */
async function beat(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  await Promise.resolve()
}

const REQUEST = {
  description: 'CI on PR #482 to finish',
  reason: 'so I can read the failing job',
  command: 'gh pr checks 482'
}

beforeEach(() => {
  clock = START
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('setting a monitor', () => {
  it('returns at once, naming the monitor and the timing in force', async () => {
    const rig = rigOf()
    const answer = await rig.model.tools.set(SESSION, '/repos/crucible', {
      ...REQUEST,
      intervalSeconds: 1,
      timeoutSeconds: 60
    })

    expect(answer).toContain('m-0001')
    // Clamped to the floor, and the answer says what is really in force.
    expect(answer).toContain('every 5s')
    expect(answer).toContain('after 1m')
    expect(answer).toContain('/repos/crucible')
    const [live] = (await rig.model.snapshot()).monitors
    expect(live).toMatchObject({
      id: 'm-0001',
      sessionId: 's1',
      description: REQUEST.description,
      reason: REQUEST.reason,
      command: REQUEST.command,
      cwd: '/repos/crucible',
      intervalMs: 5_000,
      timeoutMs: 60_000,
      checks: 0
    })
  })

  it('sets no monitor at all when the call is missing a field', async () => {
    const rig = rigOf()
    await expect(
      rig.model.tools.set(SESSION, '/repos', { description: 'x', reason: '', command: 'c' })
    ).rejects.toThrow(/reason/)
    expect((await rig.model.snapshot()).monitors).toEqual([])
  })

  it('makes two monitors of two calls, however alike they read', async () => {
    const rig = rigOf()
    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    expect((await rig.model.snapshot()).monitors).toHaveLength(2)
  })

  it('checks at once rather than waiting out the first interval', async () => {
    const rig = rigOf()
    await rig.model.tools.set(SESSION, '/repos/crucible', REQUEST)
    expect(rig.checks.runs).toEqual([{ command: REQUEST.command, cwd: '/repos/crucible' }])
  })

  it('runs every check in the directory the monitor was set in, whatever moved since', async () => {
    const rig = rigOf()
    await rig.model.tools.set(SESSION, '/repos/crucible', REQUEST)
    await beat()
    await tick(30_000)
    expect(rig.checks.runs.map((run) => run.cwd)).toEqual(['/repos/crucible', '/repos/crucible'])
    expect(rig.store.current[0].cwd).toBe('/repos/crucible')
  })
})

describe('the check loop', () => {
  it('keeps waiting on any non-zero exit and records what it printed', async () => {
    const rig = rigOf()
    rig.checks.script(REQUEST.command, [
      { kind: 'exited', exitCode: 1, output: 'in_progress\n', stderr: '' }
    ])
    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    await beat()

    const [live] = (await rig.model.snapshot()).monitors
    expect(live.checks).toBe(1)
    expect(live.last?.output.text).toBe('in_progress')
    expect(rig.delivered).toEqual([])
  })

  it('never overlaps two checks of one monitor', async () => {
    const rig = rigOf()
    rig.checks.hold(REQUEST.command)
    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    await tick(120_000)
    // The interval passed four times over and the first check has not
    // finished, so nothing else was started.
    expect(rig.checks.runs).toHaveLength(1)

    rig.checks.settle(REQUEST.command, {
      kind: 'exited',
      exitCode: 1,
      output: 'still',
      stderr: ''
    })
    await beat()
    // The next one is an interval after the previous finished, not after it
    // started.
    await tick(29_000)
    expect(rig.checks.runs).toHaveLength(1)
    await tick(1_000)
    expect(rig.checks.runs).toHaveLength(2)
  })

  it('costs the agent nothing at all while it waits', async () => {
    const rig = rigOf()
    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    await tick(20 * 60_000)
    expect(rig.checks.runs.length).toBeGreaterThan(10)
    expect(rig.delivered).toEqual([])
  })
})

describe('how a monitor ends', () => {
  it('ends condition met on an exit of 0, and the wake carries the output', async () => {
    const rig = rigOf()
    rig.checks.script(REQUEST.command, [
      { kind: 'exited', exitCode: 1, output: 'in_progress', stderr: '' },
      { kind: 'exited', exitCode: 0, output: 'completed', stderr: '' }
    ])
    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    await beat()
    await tick(30_000)

    expect(rig.delivered).toHaveLength(1)
    expect(rig.delivered[0].message.text).toContain('condition met')
    expect(rig.delivered[0].message.text).toContain('completed')
    expect(rig.delivered[0].message.text).toContain('2 checks')
    expect((await rig.model.snapshot()).monitors).toEqual([])
    expect(rig.store.current).toEqual([])
  })

  it('ends timed out when the clock runs out with nothing having passed', async () => {
    const rig = rigOf()
    await rig.model.tools.set(SESSION, '/repos', { ...REQUEST, timeoutSeconds: 60 })
    await tick(61_000)

    expect(rig.delivered).toHaveLength(1)
    expect(rig.delivered[0].message.card?.tone).toBe('warn')
    expect(rig.delivered[0].message.text).toContain('timed out')
  })

  it('times out even with a check still in flight, and that check is used for nothing', async () => {
    const rig = rigOf()
    rig.checks.hold(REQUEST.command)
    await rig.model.tools.set(SESSION, '/repos', { ...REQUEST, timeoutSeconds: 60 })
    await tick(61_000)

    expect(rig.delivered[0].message.text).toContain('timed out')
    expect(rig.checks.killed).toContain(REQUEST.command)
    // The late result lands on a monitor that has already ended and changes
    // nothing: still one wake, still no live record.
    rig.checks.settle(REQUEST.command, {
      kind: 'exited',
      exitCode: 0,
      output: 'too late',
      stderr: ''
    })
    await beat()
    expect(rig.delivered).toHaveLength(1)
    expect((await rig.model.snapshot()).monitors).toEqual([])
  })

  it('lets a check that already exited 0 win the clock', async () => {
    const rig = rigOf()
    rig.checks.script(REQUEST.command, [
      { kind: 'exited', exitCode: 0, output: 'done', stderr: '' }
    ])
    await rig.model.tools.set(SESSION, '/repos', { ...REQUEST, timeoutSeconds: 1 })
    await beat()
    await tick(5_000)
    expect(rig.delivered).toHaveLength(1)
    expect(rig.delivered[0].message.text).toContain('condition met')
  })

  it('breaks at once when the check cannot be run at all', async () => {
    const rig = rigOf()
    rig.checks.script(REQUEST.command, [{ kind: 'failed', message: 'spawn bash ENOENT' }])
    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    await beat()

    expect(rig.delivered).toHaveLength(1)
    expect(rig.delivered[0].message.text).toContain('check broke')
    expect(rig.delivered[0].message.text).toContain('spawn bash ENOENT')
    expect(rig.delivered[0].message.card?.tone).toBe('bad')
  })

  it('breaks at once on bash\u2019s own "cannot run this"', async () => {
    const rig = rigOf()
    rig.checks.script(REQUEST.command, [
      { kind: 'exited', exitCode: 127, output: 'gh: command not found', stderr: 'gh: command not found' }
    ])
    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    await beat()
    expect(rig.delivered[0].message.text).toContain('gh: command not found')
  })

  it('breaks only on the third identical failure, never on the first', async () => {
    const rig = rigOf()
    const noise = 'gh: Not logged in to github.com.\n'
    rig.checks.script(REQUEST.command, [
      { kind: 'exited', exitCode: 4, output: noise, stderr: noise }
    ])
    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    await beat()
    expect(rig.delivered).toEqual([])
    await tick(30_000)
    expect(rig.delivered).toEqual([])
    await tick(30_000)

    expect(rig.delivered).toHaveLength(1)
    expect(rig.delivered[0].message.text).toContain('check broke')
    expect(rig.delivered[0].message.text).toContain('Not logged in')
    expect(rig.delivered[0].message.text).toContain('3 checks')
  })

  // The record keeps a strike's stderr so the next check can be compared with
  // it, and that copy is written to the store on every check and handed to the
  // wake when the third strike lands. A chatty failing check must not grow
  // either without limit.
  it('keeps a chatty failure bounded, in the record and in the wake it becomes', async () => {
    const rig = rigOf()
    const noise = `${'x'.repeat(500_000)}\n`
    rig.checks.script(REQUEST.command, [
      { kind: 'exited', exitCode: 4, output: noise, stderr: noise }
    ])
    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    await beat()

    // Two strikes in: still live, and what the store holds of the failure is
    // no more than a retained output ever is.
    const stored = JSON.stringify(rig.store.current)
    expect(stored.length).toBeLessThan(4 * RETAINED_OUTPUT_CHARS)

    await tick(30_000)
    await tick(30_000)
    expect(rig.delivered).toHaveLength(1)
    expect(rig.delivered[0].message.text).toContain('check broke')
    expect(rig.delivered[0].message.text.length).toBeLessThan(WAKE_OUTPUT_CHARS + 800)
  })

  // The other way a check's bytes become an ending's error: the process never
  // ran and said so at length. A node's ended record holds its wake until the
  // node asks for it, so that is where an unbounded error would sit in
  // monitors.json rather than passing through.
  it('keeps a long “could not run” message bounded, in the record and in the wake', async () => {
    const rig = rigOf()
    rig.checks.script(REQUEST.command, [
      { kind: 'failed', message: `no bash on this machine: ${'y'.repeat(500_000)}` }
    ])
    await rig.model.tools.set(NODE, '/worktree', REQUEST)
    await beat()

    expect(JSON.stringify(rig.store.current).length).toBeLessThan(4 * RETAINED_OUTPUT_CHARS)
    const wake = await rig.model.nodes.wait(NODE)?.wake
    expect(wake?.text).toContain('no bash on this machine')
    expect(wake?.text.length ?? 0).toBeLessThan(WAKE_OUTPUT_CHARS + 800)
  })

  it('never breaks on a quiet non-zero exit, however often it repeats', async () => {
    const rig = rigOf()
    rig.checks.script(REQUEST.command, [
      { kind: 'exited', exitCode: 1, output: 'in_progress', stderr: '' }
    ])
    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    await tick(10 * 60_000)
    expect(rig.delivered).toEqual([])
    expect((await rig.model.snapshot()).monitors[0].checks).toBeGreaterThan(10)
  })

  it('forgets a strike when the next failure is a different one', async () => {
    const rig = rigOf()
    rig.checks.script(REQUEST.command, [
      { kind: 'exited', exitCode: 4, output: 'a', stderr: 'a' },
      { kind: 'exited', exitCode: 4, output: 'b', stderr: 'b' },
      { kind: 'exited', exitCode: 4, output: 'a', stderr: 'a' },
      { kind: 'exited', exitCode: 1, output: 'quiet', stderr: '' }
    ])
    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    await beat()
    await tick(30_000)
    await tick(30_000)
    await tick(30_000)
    expect(rig.delivered).toEqual([])
  })

  it('ends exactly once and runs no further check afterwards', async () => {
    const rig = rigOf()
    rig.checks.script(REQUEST.command, [
      { kind: 'exited', exitCode: 0, output: 'done', stderr: '' }
    ])
    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    await beat()
    const ran = rig.checks.runs.length
    await tick(10 * 60_000)
    expect(rig.checks.runs).toHaveLength(ran)
    expect(rig.delivered).toHaveLength(1)
  })
})

describe('stopping a monitor', () => {
  it('stops it from the chip with no wake, and tells the agent on its next turn', async () => {
    const rig = rigOf()
    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    await beat()
    await rig.model.stop('m-0001')

    expect(rig.delivered).toEqual([])
    expect((await rig.model.snapshot()).monitors).toEqual([])
    const note = rig.model.turnStart('s1')
    expect(note).toContain('The user stopped watching')
    expect(note).toContain(REQUEST.description)
    // Once and only once.
    expect(rig.model.turnStart('s1')).toBeUndefined()
  })

  it('says nothing to another session about it', async () => {
    const rig = rigOf()
    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    await rig.model.stop('m-0001')
    expect(rig.model.turnStart('s2')).toBeUndefined()
  })

  it('composes no note when the agent stopped it itself', async () => {
    const rig = rigOf()
    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    const answer = await rig.model.tools.stop(SESSION, 'm-0001')

    expect(answer).toContain('Stopped watching')
    expect(rig.delivered).toEqual([])
    expect(rig.model.turnStart('s1')).toBeUndefined()
    expect(rig.store.current).toEqual([])
  })

  it('refuses an unknown id, an ended one, and another session\u2019s', async () => {
    const rig = rigOf()
    await rig.model.tools.set(SESSION, '/repos', REQUEST)

    expect(await rig.model.tools.stop(SESSION, 'm-9999')).toMatch(/No live monitor of yours/)
    expect(await rig.model.tools.stop(OTHER, 'm-0001')).toMatch(/No live monitor of yours/)
    await rig.model.tools.stop(SESSION, 'm-0001')
    expect(await rig.model.tools.stop(SESSION, 'm-0001')).toMatch(/No live monitor of yours/)
    // Refused, not stopped: the other session's monitor is still live.
    expect(rig.checks.runs).toHaveLength(1)
  })

  it('runs no further check for a monitor the user stopped', async () => {
    const rig = rigOf()
    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    await beat()
    await rig.model.stop('m-0001')
    const ran = rig.checks.runs.length
    await tick(5 * 60_000)
    expect(rig.checks.runs).toHaveLength(ran)
  })

  // A ✕ and a passing check can land in the same instant. The user asked for
  // the monitor to be gone and it is gone, so the click is a silent no-op:
  // nothing to stop, nothing said, and no note owed to anybody.
  it('says nothing when the ✕ lands on a monitor that has already ended', async () => {
    const rig = rigOf()
    rig.checks.script(REQUEST.command, [
      { kind: 'exited', exitCode: 0, output: 'done', stderr: '' }
    ])
    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    await beat()

    await expect(rig.model.stop('m-0001')).resolves.toBeUndefined()
    await expect(rig.model.stop('m-9999')).resolves.toBeUndefined()
    // The wake the passing check earned, and no note beside it.
    expect(rig.delivered).toHaveLength(1)
    expect(rig.model.turnStart('s1')).toBeUndefined()
  })

  it('will not let the user stop a run\u2019s wait', async () => {
    const rig = rigOf()
    await rig.model.tools.set(NODE, '/worktree', REQUEST)
    await expect(rig.model.stop('m-0001')).rejects.toThrow(/belongs to a run/)
  })
})

describe('what each agent may reach', () => {
  it('lists only its own session\u2019s monitors', async () => {
    const rig = rigOf()
    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    await rig.model.tools.set(OTHER, '/repos', { ...REQUEST, description: 'somebody else' })

    expect(await rig.model.tools.list(SESSION)).toContain(REQUEST.description)
    expect(await rig.model.tools.list(SESSION)).not.toContain('somebody else')
    expect(await rig.model.tools.list(OTHER)).not.toContain(REQUEST.description)
  })

  it('keeps a node\u2019s monitor out of every session\u2019s list and out of the snapshot', async () => {
    const rig = rigOf()
    await rig.model.tools.set(NODE, '/worktree', REQUEST)

    expect(await rig.model.tools.list(SESSION)).toMatch(/Nothing is being watched/)
    expect((await rig.model.snapshot()).monitors).toEqual([])
    // And the node can still see its own.
    expect(await rig.model.tools.list(NODE)).toContain(REQUEST.description)
  })
})

describe('a node\u2019s wait', () => {
  it('answers with what the chip should say and a promise of the next wake', async () => {
    const rig = rigOf()
    rig.checks.script(REQUEST.command, [
      { kind: 'exited', exitCode: 1, output: 'in_progress', stderr: '' },
      { kind: 'exited', exitCode: 0, output: 'completed', stderr: '' }
    ])
    await rig.model.tools.set(NODE, '/worktree', REQUEST)
    await beat()

    const waiting = rig.model.nodes.wait(NODE)
    expect(waiting?.on).toMatchObject({ monitorId: 'm-0001', description: REQUEST.description })

    let woken: string | undefined
    void waiting?.wake.then((wake) => {
      woken = wake.text
    })
    await tick(30_000)
    expect(woken).toContain('condition met')
    // Never a message to the orchestrator: a run's monitor is not news.
    expect(rig.delivered).toEqual([])
  })

  it('answers undefined when the node has nothing live and nothing owed', () => {
    const rig = rigOf()
    expect(rig.model.nodes.wait(NODE)).toBeUndefined()
  })

  it('holds a wake nobody was parked on and hands it over at the next ask', async () => {
    const rig = rigOf()
    rig.checks.script(REQUEST.command, [
      { kind: 'exited', exitCode: 0, output: 'completed', stderr: '' }
    ])
    await rig.model.tools.set(NODE, '/worktree', REQUEST)
    await beat()
    // The monitor ended while the node was mid-turn, or its run was paused.
    expect(rig.model.nodes.wait(NODE)?.on).toBeDefined()
    const waiting = rig.model.nodes.wait(NODE)
    expect(waiting).toBeUndefined()
  })

  it('rejects the pending wait when the run ends under it', async () => {
    const rig = rigOf()
    await rig.model.tools.set(NODE, '/worktree', REQUEST)
    const waiting = rig.model.nodes.wait(NODE)
    const failure = expect(waiting?.wake).rejects.toThrow()
    rig.model.release({ kind: 'run', runId: 'en42' })
    await failure
  })
})

describe('when the owner goes away', () => {
  it('ends every monitor of a removed session at once and says nothing to anybody', async () => {
    const rig = rigOf()
    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    await beat()
    const ran = rig.checks.runs.length

    rig.model.release({ kind: 'session', sessionId: 's1' })

    expect(rig.delivered).toEqual([])
    expect((await rig.model.snapshot()).monitors).toEqual([])
    expect(rig.store.current).toEqual([])
    expect(rig.model.turnStart('s1')).toBeUndefined()
    await tick(5 * 60_000)
    expect(rig.checks.runs).toHaveLength(ran)
  })

  it('ends a run\u2019s monitors when the run is released, and only that run\u2019s', async () => {
    const rig = rigOf()
    await rig.model.tools.set(NODE, '/worktree', REQUEST)
    await rig.model.tools.set(
      { kind: 'node', runId: 'zz11', nodeId: 'builder' },
      '/other',
      REQUEST
    )
    rig.model.release({ kind: 'run', runId: 'en42' })

    expect(await rig.model.tools.list(NODE)).toMatch(/Nothing is being watched/)
    expect(await rig.model.tools.list({ kind: 'node', runId: 'zz11', nodeId: 'builder' })).toContain(
      REQUEST.description
    )
  })

  it('keeps counting the timeout whatever is on screen', async () => {
    const rig = rigOf()
    await rig.model.tools.set(SESSION, '/repos', { ...REQUEST, timeoutSeconds: 120 })
    // Nothing is told about focus, screens or views; only time passes.
    await tick(121_000)
    expect(rig.delivered[0].message.text).toContain('timed out')
  })
})

describe('across a quit', () => {
  function liveRecord(overrides: Partial<MonitorRecord> = {}): MonitorRecord {
    return {
      id: 'm-old1',
      owner: SESSION,
      description: REQUEST.description,
      reason: REQUEST.reason,
      command: REQUEST.command,
      cwd: '/repos/crucible',
      intervalMs: 30_000,
      timeoutMs: 30 * 60_000,
      setAt: new Date(START - 10 * 60_000).toISOString(),
      checks: 7,
      status: 'live',
      ...overrides
    } as MonitorRecord
  }

  it('resumes a live session monitor, with the clock having counted the gap', async () => {
    const rig = rigOf([
      liveRecord({
        last: {
          at: new Date(START - 10_000).toISOString(),
          output: { text: 'in_progress', truncated: false },
          result: { kind: 'exited', exitCode: 1 }
        }
      })
    ])
    rig.model.begin()
    await beat()

    const [live] = (await rig.model.snapshot()).monitors
    expect(live.id).toBe('m-old1')
    // Checks made counts checks, so the gap added none and the count goes on
    // rather than restarting.
    expect(live.checks).toBe(7)
    // The next check is due an interval after the last one finished, which the
    // gap has eaten most of.
    expect(rig.checks.runs).toEqual([])
    await tick(20_000)
    expect(rig.checks.runs).toHaveLength(1)
    expect((await rig.model.snapshot()).monitors[0].checks).toBe(8)
    // And the timeout counted the whole gap: 10 minutes of the 30 are gone.
    await tick(20 * 60_000)
    expect(rig.delivered[0].message.text).toContain('timed out')
  })

  it('ends one whose timeout ran out while Crucible was closed, without checking again', async () => {
    const rig = rigOf([
      liveRecord({ setAt: new Date(START - 40 * 60_000).toISOString() })
    ])
    rig.model.begin()
    await beat()

    expect(rig.checks.runs).toEqual([])
    expect(rig.delivered).toHaveLength(1)
    expect(rig.delivered[0].message.text).toContain('timed out')
  })

  it('drops a monitor whose session the user removed while Crucible was closed', async () => {
    const rig = rigOf([liveRecord()], { sessions: ['s2'] })
    rig.model.begin()
    await beat()

    expect(rig.delivered).toEqual([])
    expect(rig.checks.runs).toEqual([])
    expect(rig.store.current).toEqual([])
  })

  it('lets a node\u2019s monitor die with its interrupted run, and tells the node on resume', async () => {
    const rig = rigOf([
      liveRecord({
        id: 'm-node1',
        owner: NODE,
        last: {
          at: new Date(START - 60_000).toISOString(),
          output: { text: 'in_progress', truncated: false },
          result: { kind: 'exited', exitCode: 1 }
        }
      })
    ])
    rig.model.begin()
    await beat()

    expect(rig.checks.runs).toEqual([])
    expect(rig.delivered).toEqual([])
    expect(rig.model.nodes.wait(NODE)).toBeUndefined()

    const lost = rig.model.nodes.takeLost(NODE)
    expect(lost).toHaveLength(1)
    expect(lost[0]).toMatchObject({
      description: REQUEST.description,
      command: REQUEST.command,
      timeoutMs: 30 * 60_000
    })
    // Handed over once and then gone.
    expect(rig.model.nodes.takeLost(NODE)).toEqual([])
  })

  // A wake held back because the run was paused is an answer the node was
  // owed, and the quit is the one thing that can never hand it over. It is
  // treated as a live monitor is: named in the resume notice, with the outcome
  // it reached, and no wake delivered.
  it('tells a resumed node how a wake it never got had ended', async () => {
    const rig = rigOf([
      {
        ...(liveRecord({ id: 'm-node2', owner: NODE }) as MonitorRecord),
        status: 'ended',
        endedAt: new Date(START - 5 * 60_000).toISOString(),
        owed: { kind: 'wake', ending: { reason: 'met' } }
      } as MonitorRecord
    ])
    rig.model.begin()
    await beat()

    expect(rig.delivered).toEqual([])
    expect(rig.model.nodes.wait(NODE)).toBeUndefined()

    const lost = rig.model.nodes.takeLost(NODE)
    expect(lost).toEqual([
      expect.objectContaining({
        description: REQUEST.description,
        command: REQUEST.command,
        ending: { reason: 'met' }
      })
    ])
    expect(lostMonitorsNotice(lost)).toContain('condition met')
    expect(rig.model.nodes.takeLost(NODE)).toEqual([])
  })

  it('holds a wake it could not deliver and delivers it when the shell is up', async () => {
    const rig = rigOf()
    rig.refuseDelivery(true)
    rig.checks.script(REQUEST.command, [
      { kind: 'exited', exitCode: 0, output: 'completed', stderr: '' }
    ])
    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    await beat()
    expect(rig.delivered).toEqual([])
    expect(rig.store.current).toHaveLength(1)

    rig.refuseDelivery(false)
    rig.model.begin()
    await beat()
    expect(rig.delivered).toHaveLength(1)
    expect(rig.store.current).toEqual([])
  })
})

describe('what the strip is shown', () => {
  it('announces the whole snapshot on every change, and never an ended monitor', async () => {
    const rig = rigOf()
    const seen: number[] = []
    rig.model.onEvent((event) => seen.push(event.snapshot.monitors.length))

    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    await beat()
    await rig.model.stop('m-0001')

    expect(seen[0]).toBe(1)
    expect(seen.at(-1)).toBe(0)
  })

  it('leaves the strip before the wake is delivered, so the chip never outlives it', async () => {
    const rig = rigOf()
    const order: string[] = []
    rig.model.onEvent((event) => order.push(`snapshot:${event.snapshot.monitors.length}`))
    rig.checks.script(REQUEST.command, [
      { kind: 'exited', exitCode: 0, output: 'completed', stderr: '' }
    ])
    await rig.model.tools.set(SESSION, '/repos', REQUEST)
    order.push('set')
    await beat()
    order.push(`delivered:${rig.delivered.length}`)

    expect(order.indexOf('snapshot:0')).toBeLessThan(order.indexOf('delivered:1'))
  })
})
