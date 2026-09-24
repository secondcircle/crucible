import type { Rule } from '../../../resources/rule-lib/rule.ts'
import { needsJudge, type Scenario } from '../../../resources/rule-lib/test.ts'
import { evaluate, type Evaluated, type Evaluation } from './evaluate.ts'
import type { JudgeLike } from './judge.ts'

// A rule's scenarios run through `evaluate`, exactly as the live hooks call
// it. What a scenario asserts decides how deep it runs: items only stay in the
// extractor and cost nothing; actions and feedback need the judge.

export type ScenarioStatus = 'passed' | 'failed' | 'skipped'

export interface ScenarioResult {
  readonly name: string
  readonly needsJudge: boolean
  readonly status: ScenarioStatus
  readonly problems: readonly string[]
  readonly results: readonly Evaluated[]
}

/** One line of what the judge said about an item: `purpose narrates@0.96`. */
export function answersLine(r: Evaluated): string {
  if (!r.answers) return ''
  return Object.entries(r.answers as unknown as Record<string, Record<string, unknown>>)
    .map(([k, v]) => {
      if (typeof v.noul === 'number') return `${k} ${v.noul.toFixed(2)}`
      if (typeof v.choice === 'string') return `${k} ${v.choice}@${Number(v.confidence).toFixed(2)}`
      return `${k} ${Number(v.score).toFixed(2)}`
    })
    .join(', ')
}

function check(scenario: Scenario, evaluations: readonly Evaluation[]): string[] {
  const problems: string[] = []
  const results = evaluations.flatMap((e) => e.results)
  const e = scenario.expect
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
      else if (r.action !== a.is) problems.push(`line ${r.item.line}: ${r.action}, expected ${a.is} (${answersLine(r)})`)
    }
  }
  if (e.feedbackIncludes !== undefined) {
    const f = results.find((r) => r.action !== 'pass')?.feedback
    if (!f?.includes(e.feedbackIncludes))
      problems.push(`feedback was:\n      ${f}\n    expected it to include:\n      ${e.feedbackIncludes}`)
  }
  if (e.feedback !== undefined) {
    const f = results.find((r) => r.action !== 'pass')?.feedback
    if (f !== e.feedback) problems.push(`feedback was:\n      ${f}\n    expected:\n      ${e.feedback}`)
  }
  return problems
}

/**
 * Runs every scenario against the repo. With no judge, the ones that need it
 * are skipped, never passed.
 */
export async function runScenarios(
  rule: Rule,
  scenarios: readonly Scenario[],
  repo: string,
  judge: JudgeLike | undefined
): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = []
  for (const scenario of scenarios) {
    const judged = needsJudge(scenario.expect)
    if (judged && judge === undefined) {
      out.push({ name: scenario.name, needsJudge: true, status: 'skipped', problems: [], results: [] })
      continue
    }
    let evaluations: Evaluation[] = []
    const problems: string[] = []
    try {
      const events = await scenario.source({ repo })
      evaluations = await evaluate(rule, events, { repo }, judged ? judge : undefined)
      problems.push(...check(scenario, evaluations))
    } catch (cause) {
      problems.push(cause instanceof Error ? cause.message : String(cause))
    }
    out.push({
      name: scenario.name,
      needsJudge: judged,
      status: problems.length === 0 ? 'passed' : 'failed',
      problems,
      results: evaluations.flatMap((e) => e.results)
    })
  }
  return out
}
