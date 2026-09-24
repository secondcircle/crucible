// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RULE_LIB } from '../testing/paths'
import { PUSH_RULE, ruleWorkspace, TODO_RULE, writeInto } from '../testing/workspace'
import { createRuleEngine, type JudgeConfig } from './engine'

// The engine a rule host runs: which rules it admits, and what it does when
// one of them misbehaves.

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace(files: Record<string, string>): string {
  const dir = ruleWorkspace(files)
  scratch.push(dir)
  return dir
}

function judgeConfig(via: JudgeConfig['via'], allowed: string[] = []): JudgeConfig {
  const cacheDir = mkdtempSync(join(tmpdir(), 'crucible-rules-cache-'))
  scratch.push(cacheDir)
  return { via, allowed, cacheDir, budget: 1 }
}

const JUDGED_RULE = `import { choice, defineRule } from 'crucible:rule'

export default defineRule({
  source: 'docs/names.md',
  summary: 'A name says what it holds',
  on: 'edit',
  mode: 'shadow',
  extract: (edit) => edit.after.includes('let x') ? [{ key: 'x', path: edit.path, line: 1, state: { code: edit.after } }] : [],
  judge: { model: 'jev-1.13.0', questions: { name: choice('Is the name good?', { vague: 'It says nothing', clear: 'It says what it holds' }) } },
  decide: (_item, a) => (a.name.choice === 'vague' ? 'note' : 'pass'),
  feedback: () => 'Name it for what it holds.'
})
`

const edit = (path: string, before: string | null, after: string) =>
  ({ agent: 'session', cwd: '/nowhere', event: { trigger: 'edit', path, before, after } }) as const

describe('the rule engine', () => {
  it('lists every rule with the mode its file gives and the mode in force', async () => {
    const dir = workspace({
      '.crucible/rules/todo.ts': TODO_RULE,
      '.crucible/rules/push.ts': PUSH_RULE.replace("mode: 'enforce'", "mode: 'off'")
    })
    const engine = createRuleEngine(dir, RULE_LIB)
    const catalog = await engine.load()
    expect(catalog.map((rule) => [rule.name, rule.mode, rule.running, rule.on])).toEqual([
      ['push', 'off', 'off', 'bash'],
      ['todo', 'enforce', 'enforce', 'edit']
    ])
  })

  it('keeps a rule off, with the reason, when one of its free scenarios fails', async () => {
    const dir = workspace({
      'src/a.ts': 'const a = 1\n',
      '.crucible/rules/todo.ts': TODO_RULE,
      '.crucible/rules/todo.test.ts': `import { scenario, write } from 'crucible:rule/test'
scenario('a TODO is found', write('src/a.ts', 'const a = 1\\n'), { items: 1 })
`
    })
    const engine = createRuleEngine(dir, RULE_LIB)
    const [todo] = await engine.load()
    expect(todo).toMatchObject({ mode: 'enforce', running: 'off' })
    expect(todo!.held).toEqual({ broken: true, message: expect.stringContaining('scenario "a TODO is found" failed') })
    // Nothing that is held off is fed a live event.
    expect(await engine.evaluate(edit('src/a.ts', '', '// TODO\n'))).toEqual([])
  })

  it('reads a changed file afresh, mode and all', async () => {
    const dir = workspace({ '.crucible/rules/todo.ts': TODO_RULE })
    const engine = createRuleEngine(dir, RULE_LIB)
    expect((await engine.load())[0]!.running).toBe('enforce')
    // A different size is enough for the stamp to move whatever the clock does.
    writeInto(dir, '.crucible/rules/todo.ts', TODO_RULE.replace("mode: 'enforce'", "mode: 'shadow' "))
    expect((await engine.load())[0]!.running).toBe('shadow')
    const [run] = await engine.evaluate(edit('src/a.ts', '', '// TODO: later\n'))
    expect(run).toMatchObject({ rule: 'todo', mode: 'shadow', items: 1 })
  })

  it('decides a deterministic rule from the item alone', async () => {
    const dir = workspace({ '.crucible/rules/todo.ts': TODO_RULE })
    const engine = createRuleEngine(dir, RULE_LIB)
    const [run] = await engine.evaluate(edit('src/a.ts', 'a\n', 'a\n// TODO: later\n'))
    expect(run!.results).toEqual([
      expect.objectContaining({
        action: 'note',
        feedback: 'src/a.ts:2 leaves a TODO. Do it now or file it.',
        item: expect.objectContaining({ key: '// TODO: later', line: 2 })
      })
    ])
    expect(await engine.present({ rule: 'todo', path: 'src/a.ts', text: 'a\n// TODO: later\n' })).toEqual([
      '// TODO: later'
    ])
  })

  it('skips a rule that throws or overruns its budget, and runs the rest', async () => {
    const dir = workspace({
      '.crucible/rules/todo.ts': TODO_RULE,
      '.crucible/rules/boom.ts': TODO_RULE.replace('extract(edit) {', "extract(edit) {\n    throw new Error('no parser for this')"),
      '.crucible/rules/slow.ts': TODO_RULE.replace(
        'extract(edit) {',
        'budgetMs: 20,\n  async extract(edit) {\n    await new Promise((resolve) => setTimeout(resolve, 200))'
      )
    })
    const engine = createRuleEngine(dir, RULE_LIB)
    const runs = await engine.evaluate(edit('src/a.ts', '', '// TODO\n'))
    const by = Object.fromEntries(runs.map((run) => [run.rule, run]))
    expect(by.boom!.skip).toEqual({ kind: 'threw', message: 'extractor threw · no parser for this' })
    expect(by.slow!.skip!.kind).toBe('over-budget')
    expect(by.slow!.skip!.message).toMatch(/^extractor over budget · \d+ms > 20ms$/)
    expect(by.todo!.results).toHaveLength(1)
  })

  it('feeds a rule only the agents its scope names', async () => {
    const dir = workspace({
      '.crucible/rules/todo.ts': TODO_RULE.replace("scope: { include: ['src/**'] }", "scope: { include: ['src/**'], agents: 'nodes' }")
    })
    const engine = createRuleEngine(dir, RULE_LIB)
    expect(await engine.evaluate(edit('src/a.ts', '', '// TODO\n'))).toEqual([])
    const node = { ...edit('src/a.ts', '', '// TODO\n'), agent: 'node' as const }
    expect(await engine.evaluate(node)).toHaveLength(1)
  })

  it('keeps a judged rule off until the workspace allows its judge', async () => {
    const dir = workspace({ '.crucible/rules/names.ts': JUDGED_RULE })
    const engine = createRuleEngine(dir, RULE_LIB)
    engine.configure(judgeConfig({ kind: 'jev', apiKey: 'k' }))
    const [names] = await engine.load()
    expect(names).toMatchObject({
      running: 'off',
      held: { broken: false, message: 'stays off: this workspace does not send code to jev-1.13.0' }
    })
    expect(await engine.evaluate(edit('src/a.ts', '', 'let x = 1\n'))).toEqual([])
  })

  it('falls back, never blocks, when the judge cannot be reached', async () => {
    const dir = workspace({ '.crucible/rules/names.ts': JUDGED_RULE })
    const engine = createRuleEngine(dir, RULE_LIB)
    engine.configure(judgeConfig({ kind: 'jev' }, ['jev-1.13.0']))
    const [run] = await engine.evaluate(edit('src/a.ts', '', 'let x = 1\n'))
    expect(run!.results[0]).toMatchObject({
      action: 'log',
      skip: { kind: 'judge-unreachable', message: 'judge unreachable · no judge credential is set · log instead' }
    })
  })

  it('answers from the canned judge in the fake flavor, every probability included', async () => {
    const dir = workspace({ '.crucible/rules/names.ts': JUDGED_RULE })
    const engine = createRuleEngine(dir, RULE_LIB)
    engine.configure(judgeConfig({ kind: 'canned' }))
    const [run] = await engine.evaluate(edit('src/a.ts', '', 'let x = 1\n'))
    expect(run!.results[0]).toMatchObject({
      action: 'note',
      feedback: 'Name it for what it holds.',
      judged: {
        model: 'jev-1.13.0',
        answers: { name: { type: 'choice', choice: 'vague', probabilities: { vague: 0.86 } } },
        cached: false
      }
    })
    expect(run!.results[0]!.judged!.tokens).toBeGreaterThan(0)
  })
})
