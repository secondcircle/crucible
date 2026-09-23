// crucible rules test | explain | survey — the prototype runner.

import './register.ts'

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import type { Questions } from '@typesafe-ai/sdk'
import { evaluate, extract, type Evaluated } from './evaluate.ts'
import { commentBlocks } from './extract.ts'
import { show } from './git.ts'
import { Judge } from './judge.ts'
import { policeLabels } from './labels.ts'
import { surveyHtml, type Row } from './report.ts'
import type { EditEvent, Rule } from './rule.ts'
import { registry } from './test-api.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// TYPESAFE_API_KEY may live in the prototype's own .env rather than the shell.
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'))

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    // The checkout this prototype lives in: prototypes/rules/ → the repo root.
    repo: { type: 'string', default: resolve(root, '..', '..') },
    'extract-only': { type: 'boolean', default: false },
    budget: { type: 'string', default: '0.50' },
    at: { type: 'string', default: 'HEAD' },
    limit: { type: 'string' },
    verbose: { type: 'boolean', short: 'v', default: false },
  },
})

const [command, ruleName, target] = positionals
const repo = resolve(values.repo!)
const ctx = { repo }

// Rules live in the target repo, as they would under Crucible: <repo>/.crucible/rules/<name>.ts
const rulesDir = join(repo, '.crucible', 'rules')

async function loadRule(name: string): Promise<Rule<Questions>> {
  const rule = (await import(join(rulesDir, `${name}.ts`))).default as Rule<Questions>
  return { ...rule, name }
}

function makeJudge(): Judge | undefined {
  if (values['extract-only']) return undefined
  return new Judge({ cacheDir: join(root, '.cache', 'jev'), budget: Number(values.budget) })
}

const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

function spendLine(judge: Judge | undefined) {
  if (!judge) return dim('extract-only: no judge calls')
  return dim(`judge: ${judge.calls} calls, ${judge.hits} cached, $${judge.spent.toFixed(5)} spent`)
}

// --- test ----------------------------------------------------------------------

async function test(rule: Rule<Questions>) {
  await import(join(rulesDir, `${rule.name}.test.ts`))
  let judge = makeJudge()
  if (judge && !judge.available) {
    console.log(dim('TYPESAFE_API_KEY is not set: judge scenarios will be skipped, not passed.'))
    judge = undefined
  }
  let failed = 0
  let skipped = 0
  for (const s of registry) {
    const needsJudge = s.expect.actions !== undefined || s.expect.feedback !== undefined || s.expect.feedbackIncludes !== undefined
    if (needsJudge && !judge) {
      skipped++
      console.log(`${dim('○')} ${s.name} ${dim('(needs the judge)')}`)
      continue
    }
    const problems: string[] = []
    let evaluations
    try {
      const events = await s.source({ repo })
      evaluations = await evaluate(rule, events, ctx, needsJudge ? judge : undefined)
    } catch (cause) {
      problems.push(cause instanceof Error ? cause.message : String(cause))
    }
    const results = evaluations?.flatMap((e) => e.results) ?? []
    if (evaluations) {
      const e = s.expect
      if (e.outOfScope && evaluations.some((x) => x.inScope)) problems.push('expected out of scope, but scope admitted it')
      if (typeof e.items === 'number' && results.length !== e.items)
        problems.push(`expected ${e.items} items, extracted ${results.length}`)
      if (Array.isArray(e.items)) {
        if (results.length !== e.items.length) problems.push(`expected ${e.items.length} items, extracted ${results.length}`)
        e.items.forEach((m, i) => {
          const r = results[i]
          if (!r) return
          if (m.line !== undefined && r.item.line !== m.line) problems.push(`item ${i}: line ${r.item.line}, expected ${m.line}`)
          const state = JSON.stringify(r.item.state)
          for (const inc of m.stateIncludes ?? [])
            if (!state.includes(JSON.stringify(inc).slice(1, -1))) problems.push(`item ${i}: state lacks ${JSON.stringify(inc)}`)
        })
      }
      for (const a of e.actions ?? []) {
        const hits = results.filter((r) => a.line === undefined || r.item.line === a.line)
        if (hits.length === 0) problems.push(`no item${a.line ? ` at line ${a.line}` : ''} to check for ${a.is}`)
        for (const r of hits) {
          if (r.error) problems.push(`judge error: ${r.error}`)
          else if (r.action !== a.is) problems.push(`line ${r.item.line}: ${r.action}, expected ${a.is} ${dim(answersLine(r))}`)
        }
      }
      if (e.feedbackIncludes !== undefined) {
        const f = results.find((r) => r.action !== 'pass')?.feedback
        if (!f?.includes(e.feedbackIncludes)) problems.push(`feedback was:\n      ${f}\n    expected it to include:\n      ${e.feedbackIncludes}`)
      }
      if (e.feedback !== undefined) {
        const f = results.find((r) => r.action !== 'pass')?.feedback
        if (f !== e.feedback) problems.push(`feedback was:\n      ${f}\n    expected:\n      ${e.feedback}`)
      }
    }
    if (problems.length) {
      failed++
      console.log(`${red('✗')} ${s.name}`)
      for (const p of problems) console.log(`    ${p}`)
      if (values.verbose) for (const r of results) console.log(dim(`    state: ${JSON.stringify(r.item.state)}`))
    } else {
      console.log(`${green('✓')} ${s.name}${needsJudge ? dim(`  ${results.map(answersLine).join(' | ')}`) : ''}`)
    }
  }
  console.log(`\n${registry.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped · ${spendLine(judge)}`)
  process.exitCode = failed ? 1 : 0
}

function answersLine(r: Evaluated): string {
  if (!r.answers) return ''
  return Object.entries(r.answers)
    .map(([k, v]) => `${k} ${'noul' in v ? v.noul.toFixed(2) : 'choice' in v ? `${v.choice}@${v.confidence.toFixed(2)}` : v.score.toFixed(2)}`)
    .join(', ')
}

// --- explain --------------------------------------------------------------------

async function explain(rule: Rule<Questions>, spot: string) {
  const m = /^(.*):(\d+)$/.exec(spot)
  if (!m) throw new Error('explain wants path:line')
  const [, path, lineStr] = m
  const line = Number(lineStr) - 1
  const text = show(repo, values.at!, path!)
  if (text === null) throw new Error(`${path} not found at ${values.at}`)
  const block = (await commentBlocks(path!, text)).find((b) => b.start <= line && line <= b.end)
  if (!block) throw new Error(`no comment at ${spot}`)
  const lines = text.split('\n')
  lines.splice(block.start, block.end - block.start + 1)
  const event: EditEvent = { path: path!, before: lines.join('\n'), after: text, origin: `explain ${values.at}:${spot}` }

  const scoped = await extract(rule, event, ctx)
  console.log(`scope     ${scoped.inScope ? green('admitted') : red('out of scope')}  (${JSON.stringify(rule.scope)})`)
  console.log(`extracted ${scoped.items.length} item(s)`)
  let judge = makeJudge()
  if (judge && !judge.available) judge = undefined
  const [evaluation] = await evaluate(rule, [event], ctx, judge)
  for (const r of evaluation!.results) {
    console.log(`\nitem      key ${r.item.key}, line ${r.item.line}, meta ${JSON.stringify(r.item.meta)}`)
    console.log(`state sent to the judge:\n${JSON.stringify(r.item.state, null, 2)}`)
    if (rule.judge) console.log(`questions (${rule.judge.model}):\n${JSON.stringify(rule.judge.questions, null, 2)}`)
    if (r.error) console.log(red(`judge error: ${r.error}`))
    if (r.answers) console.log(`answers   ${answersLine(r)}${r.cached ? dim(' (cached)') : dim(` (${r.ms?.toFixed(0)} ms)`)}`)
    console.log(`action    ${r.action}`)
    if (r.feedback) console.log(`feedback  ${r.feedback}`)
  }
  console.log(`\n${spendLine(judge)}`)
}

// --- survey ---------------------------------------------------------------------

async function survey(rule: Rule<Questions>) {
  let labels = await policeLabels(repo, rule)
  if (values.limit) labels = labels.slice(0, Number(values.limit))
  let judge = makeJudge()
  if (judge && !judge.available) {
    console.log(dim('TYPESAFE_API_KEY is not set: surveying extract-only.'))
    judge = undefined
  }
  const evaluations = await evaluate(rule, labels.map((l) => l.event), ctx, judge)
  const rows: Row[] = labels.map((label, i) => ({ label, result: evaluations[i]!.results[0] }))
  const missing = rows.filter((r) => !r.result).length

  const questions = rule.judge ? Object.keys(rule.judge.questions) : []
  const first = rows.find((r) => r.result)
  const sampleRequest = first && rule.judge ? { model: rule.judge.model, state: first.result!.item.state, questions: rule.judge.questions } : undefined
  const latencies = rows.map((r) => r.result?.ms).filter((ms): ms is number => ms !== undefined && ms > 0)

  const estimate = rule.judge
    ? rows.reduce((n, r) => n + (r.result ? Judge.estimateTokens({ model: '', state: r.result.item.state, questions: rule.judge!.questions }) : 0), 0)
    : 0

  const outDir = join(root, 'reports')
  mkdirSync(outDir, { recursive: true })
  const html = join(outDir, `${rule.name!}-survey.html`)
  writeFileSync(
    html,
    surveyHtml({
      rule: rule.name!,
      repo,
      rows,
      questions,
      spent: judge?.spent ?? 0,
      calls: judge?.calls ?? 0,
      hits: judge?.hits ?? 0,
      latencies,
      sampleRequest,
      judged: judge !== undefined,
    }),
  )
  writeFileSync(
    join(outDir, `${rule.name!}-survey.json`),
    JSON.stringify(rows.map((r) => ({ ...r.label, event: undefined, result: r.result && { ...r.result, item: { ...r.result.item } } })), null, 1),
  )

  const by = (v: string) => labels.filter((l) => l.verdict === v).length
  console.log(`${labels.length} labelled comments: ${by('removed')} removed, ${by('rewritten')} rewritten, ${by('kept')} kept`)
  if (missing) console.log(red(`${missing} labels produced no item (duplicate text in the file, or out of scope)`))
  console.log(`full judged survey ≈ ${estimate.toLocaleString()} input tokens ≈ $${((estimate * 0.042) / 1e6).toFixed(4)}`)
  const errors = rows.filter((r) => r.result?.error)
  if (errors.length) console.log(red(`${errors.length} judge errors, first: ${errors[0]!.result!.error}`))
  console.log(`report: ${html}`)
  console.log(spendLine(judge))
}

// --- main -------------------------------------------------------------------------

if (!command || !ruleName) {
  console.log(`usage:
  node src/cli.ts test <rule> [--extract-only] [--budget 0.50] [-v]
  node src/cli.ts explain <rule> <path:line> [--at HEAD] [--extract-only]
  node src/cli.ts survey <rule> [--extract-only] [--limit N] [--budget 0.50]
  (--repo defaults to the checkout this prototype lives in)`)
  process.exit(2)
}

const rule = await loadRule(ruleName)
if (command === 'test') await test(rule)
else if (command === 'explain') await explain(rule, target ?? '')
else if (command === 'survey') await survey(rule)
else throw new Error(`unknown command ${command}`)
