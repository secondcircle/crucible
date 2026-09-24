import { execFileSync } from 'node:child_process'
import type { Ctx, Rule, RuleEvent } from '../../../../resources/rule-lib/rule.ts'
import * as events from '../../../../resources/rule-lib/events.ts'
import type {
  CatalogRule,
  FiringItem,
  JudgeVerdict,
  RuleAction,
  SkipKind
} from '../../../shared/rules/ledger.ts'
import { extract, judgeItems, scoped } from '../evaluate.ts'
import { cannedCall } from '../canned-judge.ts'
import { Judge, typesafeCall } from '../judge.ts'
import { loadRule, loadScenarios, ruleFiles, ruleNameOf, stampOf, type RuleLib } from '../load.ts'
import { runScenarios } from '../scenarios.ts'

// What runs inside a workspace's rule host: its rules, loaded afresh whenever
// a file changes, each admitted to shadow or enforce only after its free
// scenarios pass, and every live event run through the same pipeline the
// runner uses. A rule that throws or overruns its budget is skipped and
// reported; it never takes the others down with it.

export const DEFAULT_BUDGET_MS = 250

/** Which judges this workspace may send code to, and how to reach them. */
export interface JudgeConfig {
  // How a judged item is answered: by Jev with the credential Crucible holds
  // (none means every uncached call is unreachable), or canned, which is the
  // fake flavor's and never leaves the machine.
  readonly via: { readonly kind: 'jev'; readonly apiKey?: string } | { readonly kind: 'canned' }
  // Judges this workspace may send code to. A rule whose judge is not among
  // them stays off, so no code leaves the machine without the user's say.
  // A canned judge sends nothing anywhere and needs no allowance.
  readonly allowed: readonly string[]
  readonly cacheDir: string
  /** Dollars this host may spend on uncached calls. */
  readonly budget: number
}

/** A live event as main hands it over; the host builds what git can tell it. */
export type WireEvent =
  | { readonly trigger: 'edit'; readonly path: string; readonly before: string | null; readonly after: string }
  | { readonly trigger: 'bash'; readonly command: string }
  | { readonly trigger: 'commit'; readonly sha: string }
  | { readonly trigger: 'checkpoint'; readonly at: 'turn-end' | 'node-complete'; readonly base: string }

export interface EvaluateRequest {
  readonly agent: 'session' | 'node'
  readonly cwd: string
  readonly event: WireEvent
}

/** One item a rule decided on, or could not. */
export interface ItemResult {
  readonly item: FiringItem
  readonly action: RuleAction
  readonly feedback?: string
  readonly judged?: JudgeVerdict
  readonly skip?: { readonly kind: SkipKind; readonly message: string }
}

/** What one admitted rule did with one event. */
export interface RuleRun {
  readonly rule: string
  readonly source: string
  readonly mode: 'shadow' | 'enforce'
  readonly items: number
  readonly ms: number
  /** The rule itself failed: it threw, or ran past its budget. */
  readonly skip?: { readonly kind: 'threw' | 'over-budget'; readonly message: string }
  readonly results: readonly ItemResult[]
}

export interface RuleEngine {
  configure(judge: JudgeConfig): void
  load(): Promise<readonly CatalogRule[]>
  evaluate(request: EvaluateRequest): Promise<readonly RuleRun[]>
  /** The keys a rule finds in a whole file, as if every line were new; absent when it cannot say. */
  present(request: { readonly rule: string; readonly path: string; readonly text: string }): Promise<readonly string[] | undefined>
  head(cwd: string): string | undefined
}

interface Held {
  readonly stamp: string
  readonly rule?: Rule
  readonly entry: CatalogRule
}

function failure(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause)
  return text.split('\n')[0] ?? text
}

class OverBudget extends Error {}

/** The promise, or a rejection once `ms` has passed without it settling. */
function withinBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OverBudget(`${ms}ms`)), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

export function createRuleEngine(workspacePath: string, lib: RuleLib): RuleEngine {
  const held = new Map<string, Held>()
  let judge: Judge | undefined
  let config: JudgeConfig | undefined
  let configured = ''

  async function read(file: string): Promise<Held> {
    const name = ruleNameOf(file)
    const stamp = stampOf(file)
    let rule: Rule
    try {
      rule = await loadRule(file, lib)
    } catch (cause) {
      return {
        stamp,
        entry: {
          name,
          summary: '',
          source: '',
          on: 'edit',
          mode: 'off',
          running: 'off',
          agents: 'both',
          held: { broken: true, message: `would not load: ${failure(cause)}` }
        }
      }
    }
    const entry: CatalogRule = {
      name,
      summary: rule.summary,
      source: rule.source,
      on: rule.on,
      mode: rule.mode,
      running: rule.mode,
      ...(rule.judge === undefined ? {} : { judge: rule.judge.model }),
      agents: rule.scope?.agents ?? 'both'
    }
    if (rule.mode === 'off') return { stamp, rule, entry }
    // A rule reaches live events only once its free scenarios pass: a broken
    // extractor would otherwise judge, and bill, the wrong thing all day.
    try {
      const scenarios = await loadScenarios(file, lib)
      const results = await runScenarios(rule, scenarios, workspacePath, undefined)
      const failed = results.find((result) => result.status === 'failed')
      if (failed !== undefined) {
        return {
          stamp,
          rule,
          entry: {
            ...entry,
            running: 'off',
            held: {
              broken: true,
              message: `stays off: scenario "${failed.name}" failed — ${failed.problems[0] ?? 'no reason given'}`
            }
          }
        }
      }
    } catch (cause) {
      return { stamp, rule, entry: { ...entry, running: 'off', held: { broken: true, message: `stays off: its scenarios would not run — ${failure(cause)}` } } }
    }
    return { stamp, rule, entry }
  }

  async function refresh(): Promise<readonly CatalogRule[]> {
    const files = ruleFiles(workspacePath)
    const names = new Set(files.map(ruleNameOf))
    for (const name of [...held.keys()]) if (!names.has(name)) held.delete(name)
    for (const file of files) {
      const name = ruleNameOf(file)
      if (held.get(name)?.stamp === stampOf(file)) continue
      held.set(name, await read(file))
    }
    return [...held.values()].map(inForce).sort((a, b) => a.name.localeCompare(b.name))
  }

  /** The rule as the current judge settings leave it. */
  function inForce({ rule, entry }: Held): CatalogRule {
    if (rule?.judge === undefined || entry.running === 'off') return entry
    if (config === undefined || config.via.kind === 'canned' || config.allowed.includes(rule.judge.model)) return entry
    return { ...entry, running: 'off', held: { broken: false, message: `stays off: this workspace does not send code to ${rule.judge.model}` } }
  }

  function toEvent(request: EvaluateRequest): RuleEvent {
    const source = { repo: request.cwd }
    const event = request.event
    switch (event.trigger) {
      case 'edit':
        return { path: event.path, before: event.before, after: event.after, origin: `live edit ${event.path}` }
      case 'bash':
        return events.bash(source, event.command)
      case 'commit':
        return events.commitEvent(source, event.sha)
      case 'checkpoint':
        return events.checkpoint(source, event.base, null, event.at)
    }
  }

  async function runOne(rule: Rule, mode: 'shadow' | 'enforce', source: string, event: RuleEvent, ctx: Ctx): Promise<RuleRun | undefined> {
    if (scoped(rule, event) === undefined) return undefined
    const started = performance.now()
    let items
    try {
      items = (await withinBudget(extract(rule, event, ctx), rule.budgetMs ?? DEFAULT_BUDGET_MS)).items
    } catch (cause) {
      const ms = performance.now() - started
      return {
        rule: rule.name!,
        source,
        mode,
        items: 0,
        ms,
        skip:
          cause instanceof OverBudget
            ? { kind: 'over-budget', message: `extractor over budget · ${Math.round(ms)}ms > ${rule.budgetMs ?? DEFAULT_BUDGET_MS}ms` }
            : { kind: 'threw', message: `extractor threw · ${failure(cause)}` },
        results: []
      }
    }
    let settled
    try {
      settled = await judgeItems(rule, items, judge)
    } catch (cause) {
      return {
        rule: rule.name!,
        source,
        mode,
        items: items.length,
        ms: performance.now() - started,
        skip: { kind: 'threw', message: `decide or feedback threw · ${failure(cause)}` },
        results: []
      }
    }
    const fallback: RuleAction = rule.unavailable ?? 'log'
    const results = settled.map((result): ItemResult => {
      const item: FiringItem = {
        key: result.item.key,
        path: result.item.path,
        line: result.item.line,
        state: result.item.state,
        ...(result.item.excerpt === undefined ? {} : { excerpt: result.item.excerpt }),
        ...(result.item.meta === undefined ? {} : { meta: result.item.meta })
      }
      if (result.action !== 'unjudged') {
        return {
          item,
          action: result.action,
          ...(result.feedback === undefined ? {} : { feedback: result.feedback }),
          ...(result.answers === undefined || rule.judge === undefined
            ? {}
            : {
                judged: {
                  model: rule.judge.model,
                  answers: result.answers as unknown as Record<string, unknown>,
                  tokens: result.tokens ?? 0,
                  dollars: result.dollars ?? 0,
                  ms: result.ms ?? 0,
                  cached: result.cached ?? false
                }
              })
        }
      }
      // Never a block on a judge that could not answer: the rule falls back.
      return {
        item,
        action: fallback,
        skip: { kind: 'judge-unreachable', message: `judge unreachable · ${result.error ?? 'no answer'} · ${fallback} instead` }
      }
    })
    return { rule: rule.name!, source, mode, items: items.length, ms: performance.now() - started, results }
  }

  return {
    configure(next) {
      config = next
      const key = JSON.stringify([next.via, next.cacheDir, next.budget])
      if (key === configured) return
      configured = key
      const call =
        next.via.kind === 'canned' ? cannedCall : next.via.apiKey === undefined ? undefined : lazyCall(next.via.apiKey)
      judge = new Judge({ cacheDir: next.cacheDir, budget: next.budget, ...(call === undefined ? {} : { call }) })
    },

    load: refresh,

    async evaluate(request) {
      await refresh()
      const event = toEvent(request)
      const ctx: Ctx = { repo: request.cwd }
      const runs: RuleRun[] = []
      for (const one of held.values()) {
        const { rule } = one
        const entry = inForce(one)
        if (rule === undefined || entry.running === 'off' || rule.on !== request.event.trigger) continue
        const agents = rule.scope?.agents ?? 'both'
        if (agents === 'sessions' && request.agent !== 'session') continue
        if (agents === 'nodes' && request.agent !== 'node') continue
        const run = await runOne(rule, entry.running, rule.source, event, ctx)
        if (run !== undefined) runs.push(run)
      }
      return runs
    },

    async present({ rule: name, path, text }) {
      const rule = held.get(name)?.rule
      if (rule === undefined || rule.on !== 'edit') return undefined
      try {
        const found = await extract(rule, { path, before: null, after: text, origin: 'presence' }, { repo: workspacePath })
        return found.items.map((item) => item.key)
      } catch {
        return undefined
      }
    },

    head(cwd) {
      try {
        return execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        }).trim()
      } catch {
        return undefined
      }
    }
  }
}

/** The SDK client, built on the first call that needs it rather than at every reconfigure. */
function lazyCall(apiKey: string): NonNullable<ConstructorParameters<typeof Judge>[0]['call']> {
  let made: ReturnType<typeof typesafeCall> | undefined
  return async (request) => {
    made ??= typesafeCall(apiKey)
    return (await made)(request)
  }
}
