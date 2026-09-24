// @vitest-environment node
import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { forkRuleHost } from '../testing/host-fork'
import { RULE_LIB } from '../testing/paths'
import { ruleWorkspace, TODO_RULE } from '../testing/workspace'
import { supervisedRuleHost, type RuleHost } from './host'

// The rule host as a real process: a workspace's rules run in it, and a rule
// that holds it costs one timed-out question, never this process.

const scratch: string[] = []
const hosts: RuleHost[] = []
afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function started(files: Record<string, string>, timeoutMs?: number, onDeath?: (message: string) => void): RuleHost {
  const dir = ruleWorkspace(files)
  scratch.push(dir)
  const host = supervisedRuleHost({
    spawn: forkRuleHost,
    workspacePath: dir,
    libDir: RULE_LIB.dir,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(onDeath === undefined ? {} : { onDeath })
  })
  hosts.push(host)
  return host
}

const edit = { agent: 'session', cwd: '/nowhere', event: { trigger: 'edit', path: 'src/a.ts', before: '', after: '// TODO\n' } } as const

describe('the rule host process', () => {
  it('loads the workspace rules and evaluates an event', async () => {
    const host = started({ '.crucible/rules/todo.ts': TODO_RULE })
    expect((await host.load()).map((rule) => rule.name)).toEqual(['todo'])
    const [run] = await host.evaluate(edit)
    expect(run).toMatchObject({ rule: 'todo', mode: 'enforce', items: 1, results: [expect.objectContaining({ action: 'note' })] })
  }, 20_000)

  it('ends a host a rule holds synchronously, and starts a fresh one for the next event', async () => {
    const hang = TODO_RULE.replace('extract(edit) {', "extract(edit) {\n    if (edit.after.includes('HANG')) for (;;) {}")
    const host = started({ '.crucible/rules/todo.ts': hang }, 3000)
    await host.load()
    await expect(
      host.evaluate({ ...edit, event: { ...edit.event, after: '// HANG\n' } })
    ).rejects.toThrow('the rule host stopped answering and was ended')
    const [run] = await host.evaluate(edit)
    expect(run!.results).toHaveLength(1)
  }, 20_000)
})
