/**
 * The surface a rule file writes against: `crucible:rule`.
 *
 * A rule is one TypeScript file in `.crucible/rules/`, default-exporting
 * `defineRule({...})`, with a companion `<name>.test.ts` beside it. The loader
 * aliases `crucible:rule`, `crucible:rule/extract` and `crucible:rule/test` to
 * the copies Crucible ships, so a rule in any repository needs no
 * node_modules of its own.
 *
 * Where this code runs: in the workspace's rule host, a long-lived process of
 * its own, and in the `crucible rules` runner. Never in Crucible's main
 * process. The same `evaluate` serves both, so a passing scenario means the
 * rule does that live.
 */

import type { JsonValue, Questions, SystemOneResult } from '@typesafe-ai/sdk'

// TypeSafe's own question builders, so a rule author reads TypeSafe's docs,
// not Crucible's.
export { choice, noul, score } from '@typesafe-ai/sdk'

/**
 * off: loaded, checked and listed, never fed a live event; only the runner runs it.
 * shadow: fed live events; every action is recorded as what it would have been, and nothing reaches the agent.
 * enforce: actions reach the agent.
 */
export type Mode = 'off' | 'shadow' | 'enforce'

/** When a rule is fed: after an edit or write, before a bash call runs, after a commit, at a checkpoint. */
export type Trigger = 'edit' | 'bash' | 'commit' | 'checkpoint'

/** What any rule may decide. */
export type After = 'pass' | 'log' | 'note' | 'escalate'
/** Only before something has happened can it be refused. */
export type Before = After | 'block'
/** Only at a checkpoint can completion be held for something missing. */
export type Checkpoint = After | 'hold'

export type ActionOf<T extends Trigger> = T extends 'bash'
  ? Before
  : T extends 'checkpoint'
    ? Checkpoint
    : After

export type Action = After | 'block' | 'hold'

/** One file changed by one tool call: the text before (null for a new file) and after. */
export interface EditEvent {
  readonly path: string
  readonly before: string | null
  readonly after: string
  /** Where the event came from, for reports: "edit HEAD:src/x.ts", "commit 944f32c". */
  readonly origin: string
}

/** A bash call about to run. */
export interface BashEvent {
  readonly command: string
  readonly cwd: string
  readonly origin: string
}

/** One file of a commit or a checkpoint's diff; `after` is null for a deleted file. */
export interface FileDiff {
  readonly path: string
  readonly before: string | null
  readonly after: string | null
}

export interface CommitEvent {
  readonly sha: string
  readonly message: string
  readonly files: readonly FileDiff[]
  readonly origin: string
}

/** Everything since the node or the turn began, for rules about something missing. */
export interface CheckpointEvent {
  readonly at: 'node-complete' | 'turn-end'
  readonly base: string
  readonly files: readonly FileDiff[]
  readonly origin: string
}

export type EventOf<T extends Trigger> = T extends 'edit'
  ? EditEvent
  : T extends 'bash'
    ? BashEvent
    : T extends 'commit'
      ? CommitEvent
      : CheckpointEvent

export type RuleEvent = EditEvent | BashEvent | CommitEvent | CheckpointEvent

export interface Item {
  /** Stable across edits: derived from content, never a line number. */
  readonly key: string
  readonly path: string
  /** 1-based line of the thing judged, in the text after the change. */
  readonly line: number
  /** What the judge reads. Named JSON fields, which Jev's docs recommend. */
  readonly state: { readonly [field: string]: JsonValue } | string
  readonly meta?: Record<string, unknown>
  /** Set when the extractor already knows the answer; the judge is skipped. */
  readonly decided?: Action
  /**
   * The item in its surroundings, for the person reading a firing: the text
   * before it, the item itself, and the text after it.
   */
  readonly excerpt?: { readonly before: string; readonly focus: string; readonly after: string }
}

export interface Ctx {
  /** The checkout the event happened in. */
  readonly repo: string
}

export type Answers<Q extends Questions> = SystemOneResult<Q>['answers']

export interface Rule<T extends Trigger = Trigger, Q extends Questions = Questions> {
  /** Set by the loader from the file name. */
  name?: string
  /** The document this rule enforces. Named in every piece of feedback. */
  source: string
  /** One line, shown in feedback and on the rules board. */
  summary: string
  on: T
  scope?: {
    /** Path globs; edit, commit and checkpoint triggers only. */
    include?: string[]
    exclude?: string[]
    /** Default 'both'. */
    agents?: 'sessions' | 'nodes' | 'both'
  }
  mode: Mode
  /** How long `extract` may take on one event before the rule is skipped as broken. Default 250. */
  budgetMs?: number
  /** Code decides what to judge. An empty list means the rule doesn't apply to this event. */
  extract(event: EventOf<T>, ctx: Ctx): Item[] | Promise<Item[]>
  /** Absent: a deterministic rule, and decide() reads item.meta alone. */
  judge?: { model: string; questions: Q }
  decide(item: Item, answers: Answers<Q>): ActionOf<T>
  feedback(item: Item, answers: Answers<Q>): string
  /** When the judge can't be reached. Never 'block'. Default 'log'. */
  unavailable?: 'log' | 'escalate'
}

export function defineRule<T extends Trigger, const Q extends Questions>(
  rule: Rule<T, Q>
): Rule<T, Q> {
  return rule
}
