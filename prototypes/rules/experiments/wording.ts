// Does rewording the questions separate police-removed from police-kept short comments better?
// Balanced sample of 1-2 line comments; every variant over the same items; answers cached.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { choice, noul } from '@typesafe-ai/sdk'
import { Judge } from '../src/judge.ts'

const root = new URL('..', import.meta.url).pathname
process.loadEnvFile(join(root, '.env'))
const rows = JSON.parse(readFileSync(join(root, 'reports/comments-survey.json'), 'utf8'))
const short = rows.filter((r: any) => r.result?.answers && r.result.item.meta.lines <= 2)
function sample(v: string, n: number) {
  const xs = short.filter((r: any) => r.verdict === v)
  let seed = 11
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  return xs.map((x: any) => [rnd(), x]).sort((a: any, b: any) => a[0] - b[0]).slice(0, n).map((p: any) => p[1])
}
const items = [...sample('removed', 200), ...sample('kept', 200)]

const full = {
  lose: noul(
    'Suppose the comment in `comment` were deleted. Would a competent programmer reading the code around it lose information they could not quickly get from the code itself?',
    { true: 'The comment carries something the code cannot show: a reason, a constraint, a trap.', false: 'Everything the comment says can be read or easily inferred from the code.' },
  ),
  obvious: noul(
    'Would a competent programmer reading only the code in `following_code` already know or easily guess everything the comment in `comment` says?',
  ),
  purpose: choice('What is the comment in `comment` mainly doing?', {
    narrates: 'Restates or summarizes what the adjacent code does, or names what a value is, which the code already shows.',
    why: 'Explains the reason for a non-obvious choice: a constraint, a failure the obvious approach would hit, or an intent the code cannot show.',
    contract: 'States a guarantee or rule that callers rely on and the signature does not show.',
    pointer: 'Points to something outside the code: a document, an ADR, an issue or question id, a design mock, or how the code came to be.',
    label: 'Names a section or a group of lines.',
  }),
}
const narrow = { obvious_narrow: full.obvious }

const judge = new Judge({ cacheDir: join(root, '.cache', 'jev'), budget: 0.1, concurrency: 10 })
const reqsFull = items.map((r: any) => ({ model: 'jev-1.13.0', state: r.result.item.state, questions: full }))
const reqsNarrow = items.map((r: any) => {
  const s = r.result.item.state
  return { model: 'jev-1.13.0', state: { comment: s.comment, following_code: s.following_code.split('\n').slice(0, 4).join('\n') }, questions: narrow }
})
console.log('preview', judge.preview(reqsFull), judge.preview(reqsNarrow))
const a = await judge.askAll(reqsFull)
const b = await judge.askAll(reqsNarrow)
const out = items.map((r: any, i: number) => ({
  verdict: r.verdict, text: r.text, lines: r.result.item.meta.lines, jsdoc: r.result.item.state.comment.startsWith('/**'),
  base: r.result.answers,
  full: (a[i] as any).result?.answers, narrow: (b[i] as any).result?.answers,
}))
writeFileSync(join(root, 'reports/wording.json'), JSON.stringify(out, null, 1))
console.log(`calls ${judge.calls}, cached ${judge.hits}, spent $${judge.spent.toFixed(4)}`)
