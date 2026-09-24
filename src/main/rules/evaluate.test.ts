// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Questions, SystemOneResult } from '@typesafe-ai/sdk'
import { afterAll, describe, expect, it } from 'vitest'
import { Judge, type JudgeRequest } from './judge'
import { loadRule, loadScenarios, ruleFiles } from './load'
import { runScenarios } from './scenarios'
import { evaluate } from './evaluate'
import { REPO_ROOT, RULE_LIB } from './testing/paths'

// The comments rule and its sixteen scenarios, run through the app's own
// pipeline against this repository's history. The extraction scenarios run
// for real and cost nothing. The judgment scenarios run against a judge that
// answers the way Jev answered them when they were written, so what is under
// test is everything the rule does with an answer: decide and feedback.

const COMMENTS = join(REPO_ROOT, '.crucible', 'rules', 'comments.ts')

const scratch = mkdtempSync(join(tmpdir(), 'crucible-rules-eval-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Jev's recorded answers, by a phrase of the comment it was asked about. */
const RECORDED: readonly { readonly phrase: string; readonly choice: string; readonly confidence: number }[] = [
  { phrase: 'Count the validation retries', choice: 'narrates', confidence: 0.96 },
  { phrase: 'strands the rest behind a long tool call', choice: 'why', confidence: 0.91 },
  { phrase: 'three tries at a valid completion', choice: 'why', confidence: 0.55 },
  { phrase: 'See ADR 0012', choice: 'pointer', confidence: 0.64 },
  { phrase: 'Read from the element rather than from the draft prop', choice: 'why', confidence: 0.88 },
  { phrase: 'A description survives the prompt override', choice: 'why', confidence: 0.83 },
  { phrase: 'Output can arrive before the id of the run', choice: 'why', confidence: 0.79 },
  { phrase: '', choice: 'narrates', confidence: 0.9 }
]

function answerFor(state: JudgeRequest['state']): SystemOneResult<Questions> {
  const comment = typeof state === 'string' ? state : String(state.comment)
  const recorded = RECORDED.find((entry) => comment.includes(entry.phrase))!
  const options = ['narrates', 'why', 'contract', 'pointer', 'label']
  const rest = (1 - recorded.confidence) / (options.length - 1)
  return {
    model: 'jev-1.13.0',
    answers: {
      purpose: {
        type: 'choice',
        choice: recorded.choice,
        confidence: recorded.confidence,
        probabilities: Object.fromEntries(
          options.map((option) => [option, option === recorded.choice ? recorded.confidence : rest])
        )
      }
    },
    usage: { input_tokens: 700, output_tokens: 0 }
  } as never
}

function recordedJudge(): Judge {
  return new Judge({
    cacheDir: mkdtempSync(join(scratch, 'cache-')),
    budget: 1,
    call: async (request) => answerFor(request.state)
  })
}

describe('the comments rule through the app runner', () => {
  it('is found where the loader looks', () => {
    expect(ruleFiles(REPO_ROOT)).toContain(COMMENTS)
  })

  it('passes every extraction scenario for free', async () => {
    const rule = await loadRule(COMMENTS, RULE_LIB)
    const scenarios = await loadScenarios(COMMENTS, RULE_LIB)
    const results = await runScenarios(rule, scenarios, REPO_ROOT, undefined)
    const free = results.filter((result) => !result.needsJudge)
    expect(free).toHaveLength(6)
    expect(free.filter((result) => result.status !== 'passed')).toEqual([])
    // Without a judge the rest are skipped, never passed.
    expect(results.filter((result) => result.needsJudge).map((result) => result.status)).toEqual(
      Array(10).fill('skipped')
    )
  })

  it('passes every judgment scenario on the answers Jev gave', async () => {
    const rule = await loadRule(COMMENTS, RULE_LIB)
    const scenarios = await loadScenarios(COMMENTS, RULE_LIB)
    const results = await runScenarios(rule, scenarios, REPO_ROOT, recordedJudge())
    expect(results.filter((result) => result.status !== 'passed')).toEqual([])
    expect(results).toHaveLength(16)
  })

  it('decides on length alone when a comment runs past two lines', async () => {
    const rule = await loadRule(COMMENTS, RULE_LIB)
    const [evaluation] = await evaluate(
      rule,
      [
        {
          path: 'src/x.ts',
          before: 'const a = 1\n',
          after: '// one\n// two\n// three\nconst a = 1\n',
          origin: 'test'
        }
      ],
      { repo: REPO_ROOT },
      recordedJudge()
    )
    const [result] = evaluation!.results
    expect(result!.action).toBe('note')
    expect(result!.feedback).toBe(
      'src/x.ts:1 runs 3 lines. Keep the why to a line or two; a longer trade-off belongs in an ADR.'
    )
    expect(result!.item.excerpt?.focus).toBe('// one\n// two\n// three')
    expect(result!.tokens).toBe(700)
  })

  it('reports a judge that cannot be reached on the item, never as a decision', async () => {
    const rule = await loadRule(COMMENTS, RULE_LIB)
    const judge = new Judge({ cacheDir: mkdtempSync(join(scratch, 'cache-')), budget: 1 })
    const [evaluation] = await evaluate(
      rule,
      [{ path: 'src/x.ts', before: 'x()\n', after: '// Call x.\nx()\n', origin: 'test' }],
      { repo: REPO_ROOT },
      judge
    )
    const [result] = evaluation!.results
    expect(result!.action).toBe('unjudged')
    expect(result!.error).toBe('no judge credential is set')
  })

  it('answers a repeated question from the cache, free', async () => {
    const rule = await loadRule(COMMENTS, RULE_LIB)
    const judge = recordedJudge()
    const event = { path: 'src/x.ts', before: 'x()\n', after: '// Call x.\nx()\n', origin: 'test' }
    await evaluate(rule, [event], { repo: REPO_ROOT }, judge)
    const [again] = await evaluate(rule, [event], { repo: REPO_ROOT }, judge)
    expect(again!.results[0]!.cached).toBe(true)
    expect(judge.calls).toBe(1)
    expect(judge.hits).toBe(1)
  })

  it('refuses uncached calls past the spend cap', async () => {
    const rule = await loadRule(COMMENTS, RULE_LIB)
    const judge = new Judge({
      cacheDir: mkdtempSync(join(scratch, 'cache-')),
      budget: 0,
      call: async (request) => answerFor(request.state)
    })
    const [evaluation] = await evaluate(
      rule,
      [{ path: 'src/x.ts', before: 'x()\n', after: '// Call x.\nx()\n', origin: 'test' }],
      { repo: REPO_ROOT },
      judge
    )
    expect(evaluation!.results[0]!.error).toMatch(/spend cap/)
    expect(judge.calls).toBe(0)
  })
})
