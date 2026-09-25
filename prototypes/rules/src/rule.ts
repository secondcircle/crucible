// The surface a rule file writes against: `crucible:rule` in the design.
// The prototype supports one trigger, `edit`, which is all the comments rule needs.

import type { JsonValue, Questions, SystemOneResult } from '@typesafe-ai/sdk'

export type Mode = 'off' | 'shadow' | 'enforce'
export type Action = 'pass' | 'log' | 'note' | 'escalate'

/** One file changed by one tool call: the text before (null for a new file) and after. */
export interface EditEvent {
  path: string
  before: string | null
  after: string
  /** Where the event came from, for reports: "edit HEAD:src/x.ts", "commit 944f32c". */
  origin: string
}

export interface Item {
  /** Stable across edits: derived from content, never a line number. */
  key: string
  path: string
  /** 1-based line of the thing judged, in `after`. */
  line: number
  /** What the judge reads. Named JSON fields, which Jev's docs recommend. */
  state: { [field: string]: JsonValue } | string
  meta?: Record<string, unknown>
  /** Set when the extractor already knows the answer; the judge is skipped. */
  decided?: Action
}

export interface Ctx {
  repo: string
}

export type Answers<Q extends Questions> = SystemOneResult<Q>['answers']

export interface Rule<Q extends Questions = Questions> {
  /** Set by the loader from the file name. */
  name?: string
  source: string
  summary: string
  on: 'edit'
  scope?: { include?: string[]; exclude?: string[] }
  mode: Mode
  extract(event: EditEvent, ctx: Ctx): Item[] | Promise<Item[]>
  judge?: { model: string; questions: Q }
  decide(item: Item, answers: Answers<Q>): Action
  feedback(item: Item, answers: Answers<Q>): string
}

export function defineRule<const Q extends Questions>(rule: Rule<Q>): Rule<Q> {
  return rule
}
