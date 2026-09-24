// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuleAgent, RuleNote } from '../../shared/rules/gate'
import type { Firing, LedgerLine } from '../../shared/rules/ledger'
import { createRuleGate, type GateWiring } from './gate'
import { createRuleEngine } from './host/engine'
import { inProcessRuleHost, type RuleHost } from './host/host'
import { createMemoryLedger, type RulesLedger } from './ledger'
import { RULE_LIB } from './testing/paths'
import { PUSH_RULE, ruleWorkspace, TODO_RULE } from './testing/workspace'

// The gate over a real engine in this process, a workspace of real rules and
// a ledger held in memory: what an agent reads, by which road, and what the
// ledger says about it afterwards.

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Rig {
  readonly dir: string
  readonly ledger: RulesLedger
  readonly steered: RuleNote[]
  readonly session: RuleAgent
  readonly gate: ReturnType<typeof createRuleGate>
  lines(): Promise<LedgerLine[]>
  firings(): Promise<Firing[]>
}

function rig(files: Record<string, string>, tune: (host: RuleHost) => RuleHost = (host) => host, wiring: Partial<GateWiring> = {}): Rig {
  const dir = ruleWorkspace(files)
  const cacheDir = mkdtempSync(join(tmpdir(), 'crucible-rules-cache-'))
  scratch.push(dir, cacheDir)
  const ledger = createMemoryLedger()
  const host = tune(inProcessRuleHost(createRuleEngine(dir, RULE_LIB)))
  const gate = createRuleGate({
    workspaceOf: async () => dir,
    host: () => host,
    ledger: () => ledger,
    judge: async () => ({ via: { kind: 'canned' }, allowed: [], cacheDir, budget: 1 }),
    catalog: () => [],
    readText: async (path) => readFile(path, 'utf8').catch(() => null),
    appended: () => {},
    ...wiring
  })
  const lines = async (): Promise<LedgerLine[]> => [...(await ledger.read())]
  return {
    dir,
    ledger,
    steered: [],
    session: { kind: 'session', sessionId: 's1', cwd: dir },
    gate,
    lines,
    firings: async () => (await lines()).filter((line): line is LedgerLine & Firing & { type: 'firing' } => line.type === 'firing')
  }
}

function watch(r: Rig, agent: RuleAgent = r.session) {
  return r.gate.watch(agent, { steer: (note) => r.steered.push(note) })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('the rule gate', () => {
  it('appends a fast note to the tool result and records how it travelled', async () => {
    const r = rig({ '.crucible/rules/todo.ts': TODO_RULE })
    const w = watch(r)
    const result = await w.afterEdit({ callId: 'c1', tool: 'edit', path: 'src/a.ts', before: 'a\n', after: 'a\n// TODO: x\n' })
    const read = '§ Rule "todo" (docs/todo.md): src/a.ts:2 leaves a TODO. Do it now or file it.'
    expect(result).toEqual({ appendix: `\n\n${read}` })
    const [firing] = await r.firings()
    expect(firing).toMatchObject({
      rule: 'todo',
      mode: 'enforce',
      trigger: 'edit',
      agent: { kind: 'session', sessionId: 's1' },
      toolCallId: 'c1',
      where: 'src/a.ts',
      action: 'note',
      delivery: 'inline',
      read,
      change: { tool: 'edit', added: 1, removed: 0 }
    })
    expect(firing!.tookMs).toBeGreaterThanOrEqual(0)
    expect((await r.lines()).find((line) => line.type === 'admitted')).toMatchObject({ rule: 'todo', items: 1 })
  })

  it('counts an edit with nothing to judge and writes no firing for it', async () => {
    const r = rig({ '.crucible/rules/todo.ts': TODO_RULE })
    expect(await watch(r).afterEdit({ callId: 'c1', tool: 'edit', path: 'src/a.ts', before: 'a\n', after: 'b\n' })).toEqual({})
    const lines = await r.lines()
    expect(lines.map((line) => line.type)).toEqual(['admitted'])
    expect(lines[0]).toMatchObject({ items: 0 })
  })

  it('steers a note that decides too late for the tool result', async () => {
    const slow = (host: RuleHost): RuleHost => ({
      ...host,
      evaluate: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 60))
        return host.evaluate(request)
      }
    })
    const r = rig({ '.crucible/rules/todo.ts': TODO_RULE }, slow, { inlineMs: 10 })
    const result = await watch(r).afterEdit({ callId: 'c1', tool: 'edit', path: 'src/a.ts', before: '', after: '// TODO\n' })
    expect(result).toEqual({})
    await vi.waitFor(() => expect(r.steered).toHaveLength(1))
    expect(r.steered[0]!.text).toBe('§ Rule "todo" (docs/todo.md): src/a.ts:1 leaves a TODO. Do it now or file it.')
    const [firing] = await r.firings()
    expect(firing).toMatchObject({ delivery: 'steered', id: r.steered[0]!.firingId })
    expect(firing!.tookMs).toBeGreaterThanOrEqual(50)
  })

  it('follows a late firing with the edit that came before its judge answered', async () => {
    let first = true
    const slowOnce = (host: RuleHost): RuleHost => ({
      ...host,
      evaluate: async (request) => {
        if (first) {
          first = false
          await new Promise((resolve) => setTimeout(resolve, 60))
        }
        return host.evaluate(request)
      }
    })
    const r = rig({ '.crucible/rules/todo.ts': TODO_RULE }, slowOnce, { inlineMs: 10 })
    const w = watch(r)
    await w.afterEdit({ callId: 'c1', tool: 'edit', path: 'src/a.ts', before: '', after: '// TODO\n' })
    w.said('Doing it now.')
    await w.afterEdit({ callId: 'c2', tool: 'edit', path: 'src/a.ts', before: '// TODO\n', after: 'done()\n' })
    await vi.waitFor(async () => expect((await r.lines()).some((line) => line.type === 'outcome')).toBe(true))
    const lines = await r.lines()
    const [firing] = await r.firings()
    expect(lines.find((line) => line.type === 'outcome')).toMatchObject({ firing: firing!.id, outcome: 'fixed' })
    expect(lines.find((line) => line.type === 'reaction')).toMatchObject({
      firing: firing!.id,
      said: 'Doing it now.',
      then: { tool: 'edit', path: 'src/a.ts' }
    })
  })

  it('refuses a bash call a rule blocks, inline', async () => {
    const r = rig({ '.crucible/rules/push.ts': PUSH_RULE })
    const w = watch(r)
    expect(await w.beforeBash({ callId: 'b1', command: 'git push --force' })).toEqual({
      block: '§ Rule "push" (docs/git.md): Force-pushing rewrites a shared branch. Push without --force.'
    })
    expect(await w.beforeBash({ callId: 'b2', command: 'git push' })).toEqual({})
    expect(await r.firings()).toEqual([expect.objectContaining({ action: 'block', delivery: 'blocked', where: 'git push --force' })])
  })

  it('delivers nothing for a shadow rule and still follows what came of it', async () => {
    const r = rig({ '.crucible/rules/todo.ts': TODO_RULE.replace("mode: 'enforce'", "mode: 'shadow'") })
    const w = watch(r)
    expect(await w.afterEdit({ callId: 'c1', tool: 'edit', path: 'src/a.ts', before: '', after: '// TODO\nx\n' })).toEqual({})
    await w.afterEdit({ callId: 'c2', tool: 'edit', path: 'src/a.ts', before: '// TODO\nx\n', after: 'x\n' })
    await settle()
    const lines = await r.lines()
    const firing = lines.find((line) => line.type === 'firing')
    expect(firing).toMatchObject({ mode: 'shadow', action: 'note', delivery: 'none' })
    expect(firing).not.toHaveProperty('read')
    expect(lines.find((line) => line.type === 'outcome')).toMatchObject({
      firing: (firing as Firing).id,
      outcome: 'fixed',
      how: 'at the next edit of this file'
    })
  })

  it('calls a replaced item reworded, and records what the agent did next', async () => {
    const r = rig({ '.crucible/rules/todo.ts': TODO_RULE })
    const w = watch(r)
    await w.afterEdit({ callId: 'c1', tool: 'edit', path: 'src/a.ts', before: 'x\n', after: 'x\n// TODO: fix\n' })
    w.said('Rewording that TODO.')
    await w.afterEdit({ callId: 'c2', tool: 'edit', path: 'src/a.ts', before: 'x\n// TODO: fix\n', after: 'x\n// TODO: fix it later\n' })
    await settle()
    const lines = await r.lines()
    const [first, second] = lines.filter((line) => line.type === 'firing') as Firing[]
    expect(lines.find((line) => line.type === 'outcome')).toMatchObject({ firing: first!.id, outcome: 'reworded', by: second!.id })
    expect(lines.find((line) => line.type === 'reaction')).toMatchObject({
      firing: first!.id,
      said: 'Rewording that TODO.',
      then: { tool: 'edit', path: 'src/a.ts', diff: '  x\n- // TODO: fix\n+ // TODO: fix it later' }
    })
  })

  it('calls an item still there when the turn ends ignored', async () => {
    const r = rig({ '.crucible/rules/todo.ts': TODO_RULE, 'src/a.ts': '// TODO: stays\n' })
    const w = watch(r)
    await w.turnStarted()
    await w.afterEdit({ callId: 'c1', tool: 'write', path: 'src/a.ts', before: '', after: '// TODO: stays\n' })
    expect(await w.checkpoint('turn-end')).toEqual({})
    const outcome = (await r.lines()).find((line) => line.type === 'outcome')
    expect(outcome).toMatchObject({ outcome: 'ignored', how: 'still there when the turn ended' })
  })

  it('never breaks the turn when the host fails, and records every rule it cost', async () => {
    const broken = (host: RuleHost): RuleHost => ({
      ...host,
      evaluate: async () => {
        throw new Error('the rule host exited with code 1')
      }
    })
    const r = rig({ '.crucible/rules/todo.ts': TODO_RULE }, broken, {
      catalog: () => [
        { name: 'todo', summary: '', source: 'docs/todo.md', on: 'edit', mode: 'enforce', running: 'enforce', agents: 'both' }
      ]
    })
    const result = await watch(r).afterEdit({ callId: 'c1', tool: 'edit', path: 'src/a.ts', before: '', after: '// TODO\n' })
    expect(result).toEqual({})
    expect(await r.firings()).toEqual([
      expect.objectContaining({
        rule: 'todo',
        action: 'log',
        delivery: 'none',
        skip: { kind: 'threw', message: 'the rule host failed · the rule host exited with code 1' }
      })
    ])
  })

  it('escalates a note the agent has already been given twice', async () => {
    const r = rig({ '.crucible/rules/todo.ts': TODO_RULE })
    const w = watch(r)
    for (const callId of ['c1', 'c2', 'c3']) {
      await w.afterEdit({ callId, tool: 'write', path: 'src/a.ts', before: '', after: '// TODO: same\n' })
    }
    const firings = await r.firings()
    expect(firings.map((firing) => [firing.action, firing.delivery, firing.bounced ?? false])).toEqual([
      ['note', 'inline', false],
      ['note', 'inline', false],
      ['escalate', 'none', true]
    ])
  })

  it('tags a node firing with its run and node', async () => {
    const r = rig({ '.crucible/rules/todo.ts': TODO_RULE })
    const node: RuleAgent = { kind: 'node', runId: 'e7a2', nodeId: 'builder', workflow: 'build', cwd: r.dir }
    await watch(r, node).afterEdit({ callId: 'n1', tool: 'edit', path: 'src/a.ts', before: '', after: '// TODO\n' })
    expect((await r.firings())[0]!.agent).toEqual({ kind: 'node', runId: 'e7a2', nodeId: 'builder', workflow: 'build' })
  })
})
