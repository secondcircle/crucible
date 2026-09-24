import { matchesGlob } from 'node:path'
import type { Questions } from '@typesafe-ai/sdk'
import type {
  Action,
  Answers,
  Ctx,
  Item,
  Rule,
  RuleEvent,
  Trigger
} from '../../../resources/rule-lib/rule.ts'
import type { JudgeLike } from './judge.ts'

// The one pipeline. Live hooks and the test runner both call `evaluate`; only
// the event source differs, which is what makes a passing scenario mean the
// live behaviour.

export interface Evaluated {
  readonly item: Item
  /** Absent when the extractor decided, or when judging was skipped. */
  answers?: Answers<Questions>
  /** 'unjudged' when the judge wasn't consulted (extract-only, or no rule judge asked). */
  action: Action | 'unjudged'
  feedback?: string
  cached?: boolean
  ms?: number
  tokens?: number
  dollars?: number
  error?: string
}

export interface Evaluation {
  readonly event: RuleEvent
  readonly inScope: boolean
  readonly results: Evaluated[]
}

/** The events carry no tag of their own, so their shape says which trigger made them. */
export function triggerOf(event: RuleEvent): Trigger {
  if ('command' in event) return 'bash'
  if ('sha' in event) return 'commit'
  if ('base' in event) return 'checkpoint'
  return 'edit'
}

export function inScope(rule: Rule, path: string): boolean {
  const { include, exclude } = rule.scope ?? {}
  if (include && !include.some((g) => matchesGlob(path, g))) return false
  if (exclude?.some((g) => matchesGlob(path, g))) return false
  return true
}

/** The event as the rule may see it: files outside its scope are gone, and nothing left means out of scope. */
export function scoped(rule: Rule, event: RuleEvent): RuleEvent | undefined {
  if ('command' in event) return event
  if ('files' in event) {
    const files = event.files.filter((file) => inScope(rule, file.path))
    return files.length === 0 ? undefined : { ...event, files }
  }
  return inScope(rule, event.path) ? event : undefined
}

export async function extract(
  rule: Rule,
  event: RuleEvent,
  ctx: Ctx
): Promise<{ inScope: boolean; items: Item[] }> {
  if (triggerOf(event) !== rule.on) {
    throw new Error(`the rule is on ${rule.on}, and this is a ${triggerOf(event)} event`)
  }
  const admitted = scoped(rule, event)
  if (admitted === undefined) return { inScope: false, items: [] }
  return { inScope: true, items: await rule.extract(admitted as never, ctx) }
}

/** The item's action once the judge has answered, or once the extractor has decided alone. */
function settle(rule: Rule, slot: Evaluated, answers: Answers<Questions>): void {
  slot.action = rule.decide(slot.item, answers)
  slot.feedback = slot.action === 'pass' ? undefined : rule.feedback(slot.item, answers)
}

/**
 * Settles extracted items: what the extractor decided stands, a
 * deterministic rule decides from the item alone, and the rest go to the
 * judge in one batch. With no judge they stay unjudged.
 */
export async function judgeItems(
  rule: Rule,
  items: readonly Item[],
  judge: JudgeLike | undefined
): Promise<Evaluated[]> {
  const pending: number[] = []
  const results = items.map((item, i): Evaluated => {
    if (item.decided) {
      const action = item.decided
      return {
        item,
        action,
        ...(action === 'pass' ? {} : { feedback: rule.feedback(item, {} as Answers<Questions>) })
      }
    }
    if (rule.judge === undefined) {
      const slot: Evaluated = { item, action: 'unjudged' }
      settle(rule, slot, {} as Answers<Questions>)
      return slot
    }
    if (judge) pending.push(i)
    return { item, action: 'unjudged' }
  })

  if (judge && rule.judge && pending.length > 0) {
    const { model, questions } = rule.judge
    const judged = await judge.askAll(
      pending.map((i) => ({ model, state: items[i]!.state, questions }))
    )
    judged.forEach((j, n) => {
      const slot = results[pending[n]!]!
      if (j instanceof Error) {
        slot.error = j.message
        return
      }
      slot.answers = j.result.answers as Answers<Questions>
      settle(rule, slot, slot.answers)
      slot.cached = j.cached
      slot.ms = j.ms
      slot.tokens = j.tokens
      slot.dollars = j.dollars
    })
  }
  return results
}

/** Run a rule over events. `judge` undefined means extract-only. */
export async function evaluate(
  rule: Rule,
  events: readonly RuleEvent[],
  ctx: Ctx,
  judge: JudgeLike | undefined
): Promise<Evaluation[]> {
  const extracted = await Promise.all(
    events.map(async (event) => ({ event, ...(await extract(rule, event, ctx)) }))
  )
  // One batch across every event, so a survey's thousands of items share the
  // judge's concurrency and its spend check.
  const settled = await judgeItems(
    rule,
    extracted.flatMap((x) => x.items),
    judge
  )
  let at = 0
  return extracted.map((x) => {
    const results = settled.slice(at, at + x.items.length)
    at += x.items.length
    return { event: x.event, inScope: x.inScope, results }
  })
}
