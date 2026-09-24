import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { EditEvent, Item, Rule } from '../../../resources/rule-lib/rule.ts'
import { show } from '../../../resources/rule-lib/git.ts'
import { evaluate, extract, type Evaluated } from './evaluate.ts'
import { Judge, typesafeCall, type SystemOneCall } from './judge.ts'
import { policeLabels } from './labels.ts'
import { loadRule, loadScenarios, ruleFiles, RULES_DIR, type RuleLib } from './load.ts'
import { surveyHtml, type Row } from './report.ts'
import { answersLine, runScenarios } from './scenarios.ts'
import { allowedJudgesPath, judgeCredentialPath, readAllowedJudges, readJudgeCredential } from './settings.ts'

// `crucible rules test | explain | survey`: tuning a rule without a run. The
// same loader, pipeline and judge the live hooks use, with the same two
// settings deciding whether code may leave the machine, so what passes here
// is what the rule does live.

export interface RunnerEnv {
  /** The checkout the command was run in. */
  readonly cwd: string
  readonly lib: RuleLib
  /** The user's home, where Crucible's settings are. */
  readonly home: string
  /** Crucible's state directory: the judge cache and survey reports go under it. */
  readonly stateDir: string
  /** The workspace the checkout belongs to, which is what judges are allowed for. */
  readonly workspace: string
  readonly out: (line: string) => void
  /** Stands in for the SDK's call; tests hand one in so nothing is sent. */
  readonly call?: SystemOneCall
}

export const USAGE = `usage:
  crucible rules test <rule> [--extract-only] [--budget 0.50] [-v]
  crucible rules explain <rule> <path:line> [--at <rev>] [--extract-only]
  crucible rules explain <rule> --command '<bash command>' [--extract-only]
  crucible rules survey <rule> [--extract-only] [--limit N] [--budget 0.50]
  (--repo <checkout> runs against another checkout; the default is this one)`

const colour = (code: number) => (text: string) => `\x1b[${code}m${text}\x1b[0m`
const green = colour(32)
const red = colour(31)
const dim = colour(2)

/** Runs one command line; the answer is the exit code. */
export async function runRules(argv: readonly string[], env: RunnerEnv): Promise<number> {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      'extract-only': { type: 'boolean', default: false },
      budget: { type: 'string', default: '0.50' },
      at: { type: 'string' },
      command: { type: 'string' },
      limit: { type: 'string' },
      verbose: { type: 'boolean', short: 'v', default: false }
    }
  })
  const [command, ruleName, target] = positionals
  const { out } = env
  if (command === undefined || ruleName === undefined || !['test', 'explain', 'survey'].includes(command)) {
    out(USAGE)
    return 2
  }
  const repo = resolve(env.cwd, values.repo ?? '.')
  const file = ruleFiles(repo).find((candidate) => candidate.endsWith(`/${ruleName}.ts`))
  if (file === undefined) {
    out(red(`No rule "${ruleName}" in ${join(repo, RULES_DIR)}.`))
    return 2
  }
  const rule = await loadRule(file, env.lib)
  const ctx = { repo }

  function makeJudge(): Judge | undefined {
    if (values['extract-only'] || rule.judge === undefined) return undefined
    const model = rule.judge.model
    if (!readAllowedJudges(env.home, env.workspace).includes(model)) {
      out(dim(`${env.workspace} does not send code to ${model} (${allowedJudgesPath(env.home)}): judging is skipped, never passed.`))
      return undefined
    }
    const key = readJudgeCredential(env.home)
    const call = env.call ?? (key === undefined ? undefined : lazy(key))
    if (call === undefined) {
      out(dim(`No judge credential in ${judgeCredentialPath(env.home)}: judging is skipped, never passed.`))
      return undefined
    }
    return new Judge({
      cacheDir: join(env.stateDir, 'rules', 'judge-cache', 'jev'),
      budget: Number(values.budget),
      call
    })
  }

  function spendLine(judge: Judge | undefined): string {
    if (!judge) return dim('extract-only: no judge calls')
    return dim(`judge: ${judge.calls} calls, ${judge.hits} cached, $${judge.spent.toFixed(5)} spent`)
  }

  // --- test ---------------------------------------------------------------

  async function test(): Promise<number> {
    const judge = makeJudge()
    const results = await runScenarios(rule, await loadScenarios(file!, env.lib), repo, judge)
    for (const result of results) {
      if (result.status === 'skipped') {
        out(`${dim('○')} ${result.name} ${dim('(needs the judge)')}`)
      } else if (result.status === 'failed') {
        out(`${red('✗')} ${result.name}`)
        for (const problem of result.problems) out(`    ${problem}`)
        if (values.verbose) for (const r of result.results) out(dim(`    state: ${JSON.stringify(r.item.state)}`))
      } else {
        const said = result.needsJudge ? dim(`  ${result.results.map(answersLine).join(' | ')}`) : ''
        out(`${green('✓')} ${result.name}${said}`)
      }
    }
    const count = (status: string): number => results.filter((result) => result.status === status).length
    out(`\n${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped · ${spendLine(judge)}`)
    return count('failed') > 0 ? 1 : 0
  }

  // --- explain ------------------------------------------------------------

  async function explain(): Promise<number> {
    let found: { event: Parameters<Rule['extract']>[0]; pick: (item: Item) => boolean }
    if (values.command !== undefined) {
      if (rule.on !== 'bash') throw new Error(`${ruleName} is on ${rule.on}; --command explains a bash rule`)
      found = {
        event: { command: values.command, cwd: repo, origin: 'explain' },
        pick: () => true
      }
    } else {
      if (rule.on !== 'edit') throw new Error(`${ruleName} is on ${rule.on}; path:line explains an edit rule`)
      const spot = /^(.*):(\d+)$/.exec(target ?? '')
      if (spot === null) throw new Error('explain wants path:line')
      const [, path, lineText] = spot
      const line = Number(lineText)
      const text = values.at === undefined ? readWorking(repo, path!) : show(repo, values.at, path!)
      if (text === null) throw new Error(`${path} not found ${values.at === undefined ? 'in the checkout' : `at ${values.at}`}`)
      // The whole file as if it were new: every item the rule would find in
      // it, so the one at that line is judged exactly as the live edit was.
      const event: EditEvent = { path: path!, before: null, after: text, origin: `explain ${path}:${line}` }
      found = { event, pick: (item) => item.line <= line && line <= item.line + itemLines(item) - 1 }
    }
    const scoped = await extract(rule, found.event as never, ctx)
    out(`scope     ${scoped.inScope ? green('admitted') : red('out of scope')}  (${JSON.stringify(rule.scope ?? {})})`)
    const judge = makeJudge()
    const [evaluation] = await evaluate(rule, [found.event as never], ctx, judge)
    const results = (evaluation?.results ?? []).filter((r) => found.pick(r.item))
    out(`extracted ${scoped.items.length} item(s), ${results.length} at that spot`)
    for (const r of results) describe(r)
    out(`\n${spendLine(judge)}`)
    return 0
  }

  function describe(r: Evaluated): void {
    out(`\nitem      key ${r.item.key}, line ${r.item.line}, meta ${JSON.stringify(r.item.meta)}`)
    out(`state sent to the judge:\n${JSON.stringify(r.item.state, null, 2)}`)
    if (rule.judge) out(`questions (${rule.judge.model}):\n${JSON.stringify(rule.judge.questions, null, 2)}`)
    if (r.error) out(red(`judge error: ${r.error}`))
    if (r.answers) out(`answers   ${answersLine(r)}${r.cached ? dim(' (cached)') : dim(` (${r.ms?.toFixed(0)} ms)`)}`)
    out(`action    ${r.action}`)
    if (r.feedback) out(`feedback  ${r.feedback}`)
  }

  // --- survey -------------------------------------------------------------

  async function survey(): Promise<number> {
    let labels = await policeLabels(repo, rule)
    if (values.limit !== undefined) labels = labels.slice(0, Number(values.limit))
    const judge = makeJudge()
    const evaluations = await evaluate(rule, labels.map((label) => label.event), ctx, judge)
    const rows: Row[] = labels.map((label, i) => ({ label, result: evaluations[i]!.results[0] }))
    const missing = rows.filter((row) => !row.result).length
    const questions = rule.judge ? Object.keys(rule.judge.questions) : []
    const first = rows.find((row) => row.result)
    const sampleRequest =
      first && rule.judge ? { model: rule.judge.model, state: first.result!.item.state, questions: rule.judge.questions } : undefined
    const latencies = rows.map((row) => row.result?.ms).filter((ms): ms is number => ms !== undefined && ms > 0)
    const estimate = rule.judge
      ? rows.reduce(
          (n, row) =>
            n + (row.result ? Judge.estimateTokens({ model: '', state: row.result.item.state, questions: rule.judge!.questions }) : 0),
          0
        )
      : 0

    const outDir = join(env.stateDir, 'rules', 'reports')
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
        judged: judge !== undefined
      })
    )
    writeFileSync(
      join(outDir, `${rule.name!}-survey.json`),
      JSON.stringify(
        rows.map((row) => ({ ...row.label, event: undefined, result: row.result && { ...row.result, item: { ...row.result.item } } })),
        null,
        1
      )
    )
    const by = (verdict: string): number => labels.filter((label) => label.verdict === verdict).length
    out(`${labels.length} labelled comments: ${by('removed')} removed, ${by('rewritten')} rewritten, ${by('kept')} kept`)
    if (missing) out(red(`${missing} labels produced no item (duplicate text in the file, or out of scope)`))
    out(`full judged survey ≈ ${estimate.toLocaleString()} input tokens ≈ $${((estimate * 0.042) / 1e6).toFixed(4)}`)
    const errors = rows.filter((row) => row.result?.error)
    if (errors.length) out(red(`${errors.length} judge errors, first: ${errors[0]!.result!.error}`))
    out(`report: ${html}`)
    out(spendLine(judge))
    return 0
  }

  try {
    if (command === 'test') return await test()
    if (command === 'explain') return await explain()
    return await survey()
  } catch (cause) {
    out(red(cause instanceof Error ? cause.message : String(cause)))
    return 1
  }
}

function readWorking(repo: string, path: string): string | null {
  try {
    return readFileSync(join(repo, path), 'utf8')
  } catch {
    return null
  }
}

/** How many lines an item covers, where its rule says. */
function itemLines(item: Item): number {
  const lines = Number(item.meta?.lines ?? 1)
  const excerpt = item.excerpt?.focus.split('\n').length ?? 1
  return Math.max(1, Number.isFinite(lines) ? lines : 1, excerpt)
}

function lazy(apiKey: string): SystemOneCall {
  let made: Promise<SystemOneCall> | undefined
  return async (request) => {
    made ??= typesafeCall(apiKey)
    return (await made)(request)
  }
}
