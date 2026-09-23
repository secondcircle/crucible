// Labels mined from a repo's own history: what the comment-police node actually did.
//
// For each police commit P:
//   - a comment in P^ that P deleted is `removed`; one P replaced nearby is `rewritten`.
//     Both mean the police judged the original a violation.
//   - a comment in the same files that P left alone is `kept`, but only when the branch
//     under review introduced it (blame lands in the commits just before P). The police
//     is told to judge only what its branch added, so older comments carry no verdict.
//
// Each label becomes an EditEvent in which that one comment is newly added, with P^ as
// the code around it: the state the police saw.

import type { EditEvent, Rule } from './rule.ts'
import { commentBlocks } from './extract.ts'
import { inScope } from './evaluate.ts'
import { blame, changedFiles, git, show } from './git.ts'

export type Verdict = 'removed' | 'rewritten' | 'kept'

export interface Label {
  police: string
  path: string
  line: number
  text: string
  verdict: Verdict
  introducedBy: string
  event: EditEvent
}

const WINDOW_SECONDS = 24 * 3600
const WINDOW_COMMITS = 40

function branchWindow(repo: string, police: string, time: number): Set<string> {
  const out = git(repo, ['log', '--first-parent', '--format=%H %ct', `-${WINDOW_COMMITS}`, `${police}^`])
  const shas = new Set<string>()
  for (const line of out.split('\n').filter(Boolean)) {
    const [sha, ct] = line.split(' ')
    if (Number(ct) < time - WINDOW_SECONDS) break
    shas.add(sha!)
  }
  return shas
}

function withoutBlock(text: string, start: number, end: number, raw: string, trailing: boolean): string {
  const lines = text.split('\n')
  if (trailing) {
    lines[start] = lines[start]!.replace(raw, '').replace(/\s+$/, '')
    return lines.join('\n')
  }
  lines.splice(start, end - start + 1)
  return lines.join('\n')
}

export async function policeLabels(repo: string, rule: Rule, grep = 'comment police'): Promise<Label[]> {
  const commits = git(repo, ['log', '--format=%H %ct', `--grep=${grep}`, 'HEAD'])
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(' ') as [string, string])

  const labels = new Map<string, Label>()
  for (const [police, ct] of commits) {
    const window = branchWindow(repo, police, Number(ct))
    const files = changedFiles(repo, `${police}^`, police).filter((c) => c.status === 'M' && inScope(rule, c.path))
    for (const { path } of files) {
      const before = show(repo, `${police}^`, path)
      const after = show(repo, police, path)
      if (before === null || after === null) continue
      const oldBlocks = await commentBlocks(path, before)
      const newBlocks = await commentBlocks(path, after)
      const oldTexts = new Set(oldBlocks.map((b) => b.text))
      const newTexts = new Set(newBlocks.map((b) => b.text))
      const inserted = newBlocks.filter((b) => !oldTexts.has(b.text))
      const blamed = blame(repo, `${police}^`, path)
      for (const b of oldBlocks) {
        const kept = newTexts.has(b.text)
        const introducedBy = blamed[b.start] ?? ''
        if (kept && !window.has(introducedBy)) continue
        const verdict: Verdict = kept
          ? 'kept'
          : inserted.some((n) => Math.abs(n.start - b.start) <= 6)
            ? 'rewritten'
            : 'removed'
        const key = `${path}\0${b.text}`
        const prior = labels.get(key)
        if (prior && prior.verdict !== 'kept') continue
        labels.set(key, {
          police: police.slice(0, 9),
          path,
          line: b.start + 1,
          text: b.text,
          verdict,
          introducedBy: introducedBy.slice(0, 9),
          event: {
            path,
            before: withoutBlock(before, b.start, b.end, b.raw, b.trailing),
            after: before,
            origin: `police ${police.slice(0, 9)} ${verdict}`,
          },
        })
      }
    }
  }
  return [...labels.values()]
}
