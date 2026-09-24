// The rules ledger: one append-only JSONL file per workspace recording every
// firing, every admitted event, what came of each firing and what the agent
// did next, plus the rules as they were loaded. Never pruned. Everything the
// rules board shows is read from it and from nothing else, and an agent asked
// to tune a rule reads the same file, so the line schema below is a product
// contract rather than an implementation detail.

/** The schema version every line this build writes carries. */
export const RULES_LEDGER_VERSION = 1

export type RuleMode = 'off' | 'shadow' | 'enforce'

export type RuleTrigger = 'edit' | 'bash' | 'commit' | 'checkpoint'

export type RuleAction = 'pass' | 'log' | 'note' | 'escalate' | 'block' | 'hold'

/** Which agent an event came from: a curated session, or one node of a run. */
export type RuleAgentRef =
  | { readonly kind: 'session'; readonly sessionId: string }
  | {
      readonly kind: 'node'
      readonly runId: string
      readonly nodeId: string
      readonly workflow: string
    }

/** One rule as the loader found it. */
export interface CatalogRule {
  readonly name: string
  readonly summary: string
  readonly source: string
  readonly on: RuleTrigger
  /** What the file says. */
  readonly mode: RuleMode
  // What is in force: the file's mode, or `off` when the loader held the
  // rule back because it would not load or a free scenario failed.
  readonly running: RuleMode
  /** The judge's model; absent for a deterministic rule. */
  readonly judge?: string
  readonly agents: 'sessions' | 'nodes' | 'both'
  // Why the rule is held off, in one line. A broken rule (it would not load,
  // or a free scenario failed) needs attention; a judge the workspace has not
  // allowed is the user's choice and does not.
  readonly held?: { readonly broken: boolean; readonly message: string }
}

/** The narrow piece a rule extracted, exactly as its judge read it. */
export interface FiringItem {
  readonly key: string
  readonly path: string
  readonly line: number
  readonly state: unknown
  readonly excerpt?: { readonly before: string; readonly focus: string; readonly after: string }
  readonly meta?: Record<string, unknown>
}

/** What the judge said: every answer, not only the winner, and what it cost. */
export interface JudgeVerdict {
  readonly model: string
  readonly answers: Record<string, unknown>
  readonly tokens: number
  readonly dollars: number
  readonly ms: number
  readonly cached: boolean
}

// How the feedback reached the agent. `none` is every firing whose action
// delivers nothing, and every shadow firing.
export type Delivery = 'inline' | 'steered' | 'blocked' | 'held' | 'none'

// A skip that means something is wrong. An admitted event that extracted
// nothing is never one: it is counted on an `admitted` line and nowhere else.
export type SkipKind = 'threw' | 'over-budget' | 'judge-unreachable'

export interface Firing {
  readonly id: string
  /** ISO of the moment the event reached the rule. */
  readonly at: string
  readonly rule: string
  /** The mode it ran under; a shadow firing's action is what it would have done. */
  readonly mode: 'shadow' | 'enforce'
  readonly trigger: RuleTrigger
  readonly agent: RuleAgentRef
  /** The tool call it judged, where there was one. */
  readonly toolCallId?: string
  /** The file or the command, for a row that has no item. */
  readonly where: string
  readonly item?: FiringItem
  readonly judged?: JudgeVerdict
  readonly action: RuleAction
  /** The note was turned into an escalation because the key had been noted twice already. */
  readonly bounced?: true
  /** What the rule's feedback() said. */
  readonly feedback?: string
  /** The exact text the agent read, when anything was delivered. */
  readonly read?: string
  readonly delivery: Delivery
  /** The whole path, extract to delivery. */
  readonly tookMs: number
  readonly skip?: { readonly kind: SkipKind; readonly message: string }
  /** The change the rule was fed, as its lines: "edit · 3 lines added". */
  readonly change?: { readonly tool: string; readonly added: number; readonly removed: number }
}

export type Outcome = 'fixed' | 'reworded' | 'ignored'

export interface Reaction {
  /** The agent's next words after the firing. */
  readonly said?: string
  /** The next tool call touching that file, with what it changed. */
  readonly then?: { readonly tool: string; readonly path: string; readonly diff: string }
}

export type LedgerLine =
  | { readonly v: number; readonly type: 'catalog'; readonly at: string; readonly rules: readonly CatalogRule[] }
  | {
      readonly v: number
      readonly type: 'admitted'
      readonly at: string
      readonly rule: string
      readonly agent: RuleAgentRef
      readonly trigger: RuleTrigger
      /** How many items the extractor found; zero is "nothing to judge". */
      readonly items: number
    }
  | ({ readonly v: number; readonly type: 'firing' } & Firing)
  | {
      readonly v: number
      readonly type: 'outcome'
      readonly at: string
      readonly firing: string
      readonly outcome: Outcome
      /** For a rewording, the firing that judged the new item. */
      readonly by?: string
      /** When it was read, in the board's words: "at the next edit of this file". */
      readonly how: string
    }
  | ({
      readonly v: number
      readonly type: 'reaction'
      readonly at: string
      readonly firing: string
      readonly afterMs: number
    } & Reaction)

/** Firings whose item stays open until something comes of it. */
export function tracksOutcome(firing: Pick<Firing, 'action' | 'skip'>): boolean {
  if (firing.skip !== undefined) return false
  return firing.action === 'note' || firing.action === 'escalate' || firing.action === 'hold'
}

/** One line of the file, or nothing for a line this build cannot read. */
export function parseLedgerLine(text: string): LedgerLine | undefined {
  if (text.trim() === '') return undefined
  try {
    const parsed = JSON.parse(text) as { type?: unknown }
    const known = ['catalog', 'admitted', 'firing', 'outcome', 'reaction']
    return typeof parsed === 'object' && parsed !== null && known.includes(parsed.type as string)
      ? (parsed as LedgerLine)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * What the agent reads for a firing, wherever it lands: the rule and the
 * document it enforces, then the feedback verbatim.
 */
export function ruleMessage(rule: string, source: string, feedback: string): string {
  return `§ Rule "${rule}" (${source}): ${feedback}`
}
