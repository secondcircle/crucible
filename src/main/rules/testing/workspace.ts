import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// A throwaway repository with rules in it, committed once so git has a HEAD
// for the event builders and the checkpoint to read.

export function ruleWorkspace(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'crucible-rules-ws-'))
  for (const [path, text] of Object.entries(files)) writeInto(dir, path, text)
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
  }
  git('init', '-q')
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
  return dir
}

export function writeInto(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), text, 'utf8')
}

/** A deterministic edit rule: every added line with a TODO in it is noted. */
export const TODO_RULE = `import { defineRule } from 'crucible:rule'

export default defineRule({
  source: 'docs/todo.md',
  summary: 'No TODO lands in src',
  on: 'edit',
  scope: { include: ['src/**'] },
  mode: 'enforce',
  extract(edit) {
    const before = new Set((edit.before ?? '').split('\\n'))
    return edit.after
      .split('\\n')
      .map((text, i) => ({ text, line: i + 1 }))
      .filter(({ text }) => text.includes('TODO') && !before.has(text))
      .map(({ text, line }) => ({ key: text.trim(), path: edit.path, line, state: { line: text } }))
  },
  decide: () => 'note',
  feedback: (item) => item.path + ':' + item.line + ' leaves a TODO. Do it now or file it.'
})
`

/** A bash rule that refuses a force push. */
export const PUSH_RULE = `import { defineRule } from 'crucible:rule'

export default defineRule({
  source: 'docs/git.md',
  summary: 'Never force-push',
  on: 'bash',
  mode: 'enforce',
  extract: (bash) => (bash.command.includes('--force') ? [{ key: 'force', path: '', line: 0, state: bash.command }] : []),
  decide: () => 'block',
  feedback: () => 'Force-pushing rewrites a shared branch. Push without --force.'
})
`
