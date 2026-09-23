// The one pipeline. Live hooks and the test runner both call `evaluate`; only the event source differs.

import { matchesGlob } from 'node:path'
import type { Questions } from '@typesafe-ai/sdk'
import type { Judge } from './judge.ts'
import type { Action, Answers, Ctx, EditEvent, Item, Rule } from './rule.ts'

export interface Evaluated {
  item: Item
  /** Absent when the extractor decided, or when judging was skipped. */
  answers?: Answers<Questions>
  /** 'unjudged' when the judge wasn't consulted (extract-only, or no key). */
  action: Action | 'unjudged'
  feedback?: string
  cached?: boolean
  ms?: number
  error?: string
}

export interface Evaluation {
  event: EditEvent
  inScope: boolean
  results: Evaluated[]
}

export function inScope(rule: Rule, path: string): boolean {
  const { include, exclude } = rule.scope ?? {}
  if (include && !include.some((g) => matchesGlob(path, g))) return false
  if (exclude?.some((g) => matchesGlob(path, g))) return false
  return true
}

export async function extract(rule: Rule, event: EditEvent, ctx: Ctx): Promise<{ inScope: boolean; items: Item[] }> {
  if (!inScope(rule, event.path)) return { inScope: false, items: [] }
  return { inScope: true, items: await rule.extract(event, ctx) }
}

/** Run a rule over events. `judge` undefined means extract-only. */
export async function evaluate(
  rule: Rule,
  events: EditEvent[],
  ctx: Ctx,
  judge: Judge | undefined,
): Promise<Evaluation[]> {
  const extracted = await Promise.all(events.map(async (event) => ({ event, ...(await extract(rule, event, ctx)) })))

  const pending: { at: [number, number]; item: Item }[] = []
  const evaluations: Evaluation[] = extracted.map((x, e) => ({
    event: x.event,
    inScope: x.inScope,
    results: x.items.map((item, i) => {
      if (item.decided) {
        return { item, action: item.decided, feedback: rule.feedback(item, {} as Answers<Questions>) }
      }
      if (judge && rule.judge) pending.push({ at: [e, i], item })
      return { item, action: 'unjudged' as const }
    }),
  }))

  if (judge && rule.judge && pending.length > 0) {
    const { model, questions } = rule.judge
    const judged = await judge.askAll(pending.map((p) => ({ model, state: p.item.state, questions })))
    judged.forEach((j, n) => {
      const { at, item } = pending[n]!
      const slot = evaluations[at[0]]!.results[at[1]]!
      if (j instanceof Error) {
        slot.error = j.message
        return
      }
      const answers = j.result.answers as Answers<Questions>
      slot.answers = answers
      slot.action = rule.decide(item, answers)
      slot.feedback = slot.action === 'pass' ? undefined : rule.feedback(item, answers)
      slot.cached = j.cached
      slot.ms = j.ms
    })
  }
  return evaluations
}
