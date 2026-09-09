// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NodeResult, OpenNode, RunContext, WorkflowDef } from '../authoring'
import { AUTHORING_MODULE, forkHost } from '../testing/host-fork'
import { createWorkflowHost, inProcessHost, type WorkflowHost } from './host'

// The workflow host in both its shapes. The contract suite runs every case
// against the real forked process and against the in-process stand-in the
// engine's tests use, so the fake cannot drift from the thing it stands for.
// Below it are the cases only a process can pass: being held by synchronous
// work without holding this one, dying, and being killed mid-call.

const scratch: string[] = []
const hosts: WorkflowHost[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crucible-host-'))
  scratch.push(dir)
  return dir
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.kill()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A workflow file on disk, and the host that runs it as a process. */
function forked(source: string): WorkflowHost {
  const dir = tempDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'wf.ts')
  writeFileSync(file, source, 'utf8')
  const host = createWorkflowHost(forkHost, file, AUTHORING_MODULE)
  hosts.push(host)
  return host
}

function inProcess(def: WorkflowDef): WorkflowHost {
  const host = inProcessHost(def)
  hosts.push(host)
  return host
}

// A run context that records what the workflow asked of it and answers with
// canned results, which is all a host test needs the engine to be.
function recordingContext(): RunContext & {
  readonly calls: string[]
  readonly opened: { revisions: string[]; closed: boolean }
} {
  const calls: string[] = []
  const opened = { revisions: [] as string[], closed: false }
  const result = (id: string): NodeResult => ({
    outputs: { out: `/artifacts/${id}.md` },
    verdict: { verdict: 'approved' },
    summary: `${id} done`
  })
  return {
    calls,
    opened,
    inputs: { brief: '/in/brief.md' },
    artifactDir: '/artifacts',
    cwd: '/worktree',
    async node(id, spec) {
      calls.push(`node ${id}`)
      // The engine validates through the spec's check where one is declared.
      if (spec.check !== undefined) {
        const problems = await spec.check({ out: `/artifacts/${id}.md` })
        calls.push(`check ${id}: ${problems.join('|')}`)
      }
      return result(id)
    },
    async openNode(id): Promise<OpenNode> {
      calls.push(`openNode ${id}`)
      let round = 0
      return {
        result: result(id),
        get id() {
          return round === 0 ? id : `${id}·r${round}`
        },
        async revise(message) {
          round += 1
          opened.revisions.push(message)
          return result(`${id}·r${round}`)
        },
        close() {
          opened.closed = true
        }
      }
    },
    async ask(question) {
      calls.push(`ask ${question.reason}`)
      return 'approved'
    },
    async derive(path, fromNodeId) {
      calls.push(`derive ${path} from ${fromNodeId}`)
      if (fromNodeId === 'nobody') throw new Error(`derive("${path}"): no node "nobody" in this run`)
    },
    async stage(opts) {
      calls.push(`stage ${opts.workflow}`)
      return `run→${opts.workflow}`
    }
  }
}

// One workflow, written twice: as a file for the process, as a definition
// for the stand-in. What each does is line for line the same.
const FULL_SOURCE = `
import { workflow } from 'crucible:workflow'
export default workflow({
  description: 'the contract workflow',
  inputs: { brief: 'what to build' },
  commit: false,
  plan: (inputs) => [{ id: 'first', outputs: { out: { file: 'first.md', desc: 'd' } } }],
  schedule: { cron: '*/5 * * * *', check: ({ workspacePath }) => workspacePath.endsWith('yes') },
  run: async (ctx) => {
    const first = await ctx.node('first', {
      prompt: 'p', outputs: { out: { file: 'first.md', desc: 'd' } },
      check: (outputs) => Object.keys(outputs).length === 1 ? [] : ['wrong count']
    })
    const answer = await ctx.ask({ reason: 'ok?', artifacts: { out: first.outputs.out } })
    const held = await ctx.openNode('review', { prompt: 'r' })
    const before = held.id
    const revised = await held.revise('again')
    const after = held.id
    held.close()
    await ctx.derive('/artifacts/split.md', 'first')
    const staged = await ctx.stage({ workflow: 'next', inputs: { brief: ctx.inputs.brief } })
    return { answer, before, after, revised: revised.summary, staged, cwd: ctx.cwd, dir: ctx.artifactDir }
  }
})
`

const FULL_DEF: WorkflowDef = {
  description: 'the contract workflow',
  inputs: { brief: 'what to build' },
  commit: false,
  plan: () => [{ id: 'first', outputs: { out: { file: 'first.md', desc: 'd' } } }],
  schedule: { cron: '*/5 * * * *', check: ({ workspacePath }) => workspacePath.endsWith('yes') },
  run: async (ctx) => {
    const first = await ctx.node('first', {
      prompt: 'p',
      outputs: { out: { file: 'first.md', desc: 'd' } },
      check: (outputs) => (Object.keys(outputs).length === 1 ? [] : ['wrong count'])
    })
    const answer = await ctx.ask({ reason: 'ok?', artifacts: { out: first.outputs.out } })
    const held = await ctx.openNode('review', { prompt: 'r' })
    const before = held.id
    const revised = await held.revise('again')
    const after = held.id
    held.close()
    await ctx.derive('/artifacts/split.md', 'first')
    const staged = await ctx.stage({ workflow: 'next', inputs: { brief: ctx.inputs.brief } })
    return {
      answer,
      before,
      after,
      revised: revised.summary,
      staged,
      cwd: ctx.cwd,
      dir: ctx.artifactDir
    }
  }
}

const THROWING_SOURCE = `
import { workflow } from 'crucible:workflow'
export default workflow({
  description: 'throws',
  inputs: {},
  run: async () => { throw new Error('the workflow gave up') }
})
`
const THROWING_DEF: WorkflowDef = {
  description: 'throws',
  inputs: {},
  run: async () => {
    throw new Error('the workflow gave up')
  }
}

const DERIVE_NOBODY_SOURCE = `
import { workflow } from 'crucible:workflow'
export default workflow({
  description: 'derives from nobody',
  inputs: {},
  run: async (ctx) => { await ctx.derive('/x', 'nobody'); return { reached: true } }
})
`
const DERIVE_NOBODY_DEF: WorkflowDef = {
  description: 'derives from nobody',
  inputs: {},
  run: async (ctx) => {
    await ctx.derive('/x', 'nobody')
    return { reached: true }
  }
}

describe.each([
  ['forked process', { full: () => forked(FULL_SOURCE), throwing: () => forked(THROWING_SOURCE), deriveNobody: () => forked(DERIVE_NOBODY_SOURCE) }],
  ['in process', { full: () => inProcess(FULL_DEF), throwing: () => inProcess(THROWING_DEF), deriveNobody: () => inProcess(DERIVE_NOBODY_DEF) }]
])('workflow host contract · %s', (_name, make) => {
  it('reads the manifest without running anything', async () => {
    const manifest = await make.full().manifest()
    expect(manifest).toEqual({
      description: 'the contract workflow',
      inputs: { brief: 'what to build' },
      commit: false,
      plans: true,
      schedule: { cron: '*/5 * * * *', checks: true }
    })
  })

  it('plans and answers the schedule check', async () => {
    const host = make.full()
    expect(await host.plan({ brief: '/b' })).toEqual([
      { id: 'first', outputs: { out: { file: 'first.md', desc: 'd' } } }
    ])
    expect(await host.scheduleCheck('/repo/yes')).toBe(true)
    expect(await host.scheduleCheck('/repo/no')).toBe(false)
  })

  it('runs the workflow against the context, every ctx call and check included', async () => {
    const ctx = recordingContext()
    const outputs = await make.full().run(ctx)

    expect(ctx.calls).toEqual([
      'node first',
      'check first: ',
      'ask ok?',
      'openNode review',
      'derive /artifacts/split.md from first',
      'stage next'
    ])
    expect(ctx.opened).toEqual({ revisions: ['again'], closed: true })
    expect(outputs).toEqual({
      answer: 'approved',
      before: 'review',
      after: 'review·r1',
      revised: 'review·r1 done',
      staged: 'run→next',
      cwd: '/worktree',
      dir: '/artifacts'
    })
  })

  it("rejects with the workflow's own error", async () => {
    await expect(make.throwing().run(recordingContext())).rejects.toThrow('the workflow gave up')
  })

  it("rejects a ctx call the engine refuses, with the engine's words", async () => {
    await expect(make.deriveNobody().run(recordingContext())).rejects.toThrow(
      'derive("/x"): no node "nobody" in this run'
    )
  })
})

describe('workflow host process', () => {
  it('is held by synchronous work in the file without holding this process', async () => {
    const host = forked(`
      import { workflow } from 'crucible:workflow'
      import { spawnSync } from 'node:child_process'
      export default workflow({
        description: 'blocks',
        inputs: {},
        run: async (ctx) => {
          await ctx.ask({ reason: 'before' })
          spawnSync('sleep', ['1.5'])
          await ctx.ask({ reason: 'after' })
          return { slept: true }
        }
      })
    `)
    const ctx = recordingContext()

    // The event loop here is sampled while the file sleeps; a held loop
    // would make one of these wake-ups late by about the whole sleep.
    let worstLag = 0
    let last = Date.now()
    const sampler = setInterval(() => {
      const now = Date.now()
      worstLag = Math.max(worstLag, now - last - 20)
      last = now
    }, 20)
    try {
      expect(await host.run(ctx)).toEqual({ slept: true })
    } finally {
      clearInterval(sampler)
    }
    expect(ctx.calls).toEqual(['ask before', 'ask after'])
    expect(worstLag).toBeLessThan(200)
  })

  it('kill() stops a file stuck in a loop and rejects the run at once', async () => {
    const host = forked(`
      import { workflow } from 'crucible:workflow'
      export default workflow({
        description: 'spins',
        inputs: {},
        run: async (ctx) => {
          await ctx.ask({ reason: 'started' })
          for (;;) {}
        }
      })
    `)
    const ctx = recordingContext()
    const running = host.run(ctx)
    // Once the ask has come across, the file is in its loop.
    while (ctx.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 10))

    const before = Date.now()
    host.kill()
    await expect(running).rejects.toThrow('the workflow host was stopped')
    expect(Date.now() - before).toBeLessThan(500)
  })

  it('reports a file that dies at import through the request that asked, stderr and all', async () => {
    const host = forked(`
      import { workflow } from 'crucible:workflow'
      console.error('this file is broken on purpose')
      process.exit(3)
    `)
    await expect(host.manifest()).rejects.toThrow(
      /the workflow host exited with code 3\n.*this file is broken on purpose/s
    )
  })

  it('reports a file that is not a workflow at all', async () => {
    const host = forked(`export default 42`)
    await expect(host.manifest()).rejects.toThrow('does not default-export a workflow definition')
  })

  it('rejects a run in flight when the host dies under it', async () => {
    const host = forked(`
      import { workflow } from 'crucible:workflow'
      export default workflow({
        description: 'dies',
        inputs: {},
        run: async (ctx) => {
          await ctx.ask({ reason: 'about to go' })
          process.exit(7)
        }
      })
    `)
    await expect(host.run(recordingContext())).rejects.toThrow('the workflow host exited with code 7')
  })

  it('refuses a ctx call made outside run()', async () => {
    const host = forked(`
      import { workflow } from 'crucible:workflow'
      let leaked
      export default workflow({
        description: 'leaks ctx',
        inputs: {},
        run: async (ctx) => { leaked = ctx; setTimeout(() => leaked.ask({ reason: 'late' }).catch(() => {}), 50); return {} }
      })
    `)
    // The run resolves; the late call is refused rather than served, and the
    // host is still there to be killed cleanly.
    expect(await host.run(recordingContext())).toEqual({})
    await new Promise((resolve) => setTimeout(resolve, 150))
    host.kill()
  })
})
