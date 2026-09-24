// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runRules, type RunnerEnv } from './runner'
import { REPO_ROOT, RULE_LIB } from './testing/paths'
import { ruleWorkspace, TODO_RULE, writeInto } from './testing/workspace'

// The `crucible rules` runner, driven the way bash drives it: a command line
// in, lines of text and an exit code out.

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

async function run(argv: string[], cwd: string, env: Partial<RunnerEnv> = {}): Promise<{ code: number; text: string }> {
  const lines: string[] = []
  const home = env.home ?? temp('crucible-home-')
  const code = await runRules(argv, {
    cwd,
    lib: RULE_LIB,
    home,
    stateDir: temp('crucible-state-'),
    workspace: cwd,
    out: (line) => lines.push(line),
    ...env
  })
  // eslint-disable-next-line no-control-regex
  return { code, text: lines.join('\n').replace(/\x1b\[\d+m/g, '') }
}

describe('crucible rules', () => {
  it('runs the comments rule’s free scenarios in this repository and skips the rest', async () => {
    const { code, text } = await run(['test', 'comments', '--extract-only'], REPO_ROOT)
    expect(code).toBe(0)
    expect(text).toContain('✓ a new comment is extracted with the code after it')
    expect(text).toContain('6 passed, 0 failed, 10 skipped · extract-only: no judge calls')
  }, 30_000)

  it('explains the item at a line of the working file', async () => {
    const dir = ruleWorkspace({ '.crucible/rules/todo.ts': TODO_RULE, 'src/a.ts': 'const a = 1\n// TODO: later\n' })
    scratch.push(dir)
    const { code, text } = await run(['explain', 'todo', 'src/a.ts:2'], dir)
    expect(code).toBe(0)
    expect(text).toContain('extracted 1 item(s), 1 at that spot')
    expect(text).toContain('action    note')
    expect(text).toContain('feedback  src/a.ts:2 leaves a TODO. Do it now or file it.')
  })

  it('never sends code to a judge the workspace has not allowed', async () => {
    const home = temp('crucible-home-')
    mkdirSync(join(home, '.crucible'))
    writeFileSync(join(home, '.crucible', 'typesafe.env'), 'TYPESAFE_API_KEY=k\n')
    let called = 0
    const { text } = await run(['test', 'comments'], REPO_ROOT, {
      home,
      workspace: '/somewhere/else',
      call: async () => {
        called += 1
        throw new Error('sent')
      }
    })
    expect(called).toBe(0)
    expect(text).toContain('/somewhere/else does not send code to jev-1.13.0')
  }, 30_000)

  it('surveys the comments a comment-police commit ruled on', async () => {
    const dir = ruleWorkspace({
      '.crucible/rules/comments.ts': readFileSync(join(REPO_ROOT, '.crucible', 'rules', 'comments.ts'), 'utf8'),
      'src/a.ts': 'export const a = 1\n'
    })
    scratch.push(dir)
    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' })
    }
    writeInto(dir, 'src/a.ts', '// Set a to one.\nexport const a = 1\n\n// The b export stays for the old loader.\nexport const b = 2\n')
    git('commit', '-qam', 'branch work')
    writeInto(dir, 'src/a.ts', 'export const a = 1\n\n// The b export stays for the old loader.\nexport const b = 2\n')
    git('commit', '-qam', 'comment police: trim')
    const { code, text } = await run(['survey', 'comments', '--extract-only'], dir)
    expect(code).toBe(0)
    expect(text).toContain('2 labelled comments: 1 removed, 0 rewritten, 1 kept')
    expect(text).toMatch(/report: .*comments-survey\.html/)
  }, 30_000)

  it('says how to use it when asked for something it does not do', async () => {
    const { code, text } = await run(['frobnicate'], REPO_ROOT)
    expect(code).toBe(2)
    expect(text).toContain('crucible rules test <rule>')
  })
})
