import {
  tracksOutcome,
  type CatalogRule,
  type Firing,
  type LedgerLine,
  type Outcome,
  type Reaction,
  type RuleAction,
  type RuleAgentRef
} from './ledger'

// What the rules board, the rule marks and the run view's rules tab show,
// computed from the ledger's lines and nothing else. Main runs these over the
// file, the fake flavor over canned lines, and both hand the renderer the
// same shapes.

export type BoardScope =
  | { readonly kind: 'workspace' }
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'run'; readonly runId: string }

export type BoardWindow = 'today' | '7d' | '30d' | 'all'

export const BOARD_WINDOWS: readonly BoardWindow[] = ['today', '7d', '30d', 'all']

/** What came of a firing: an outcome, or still open. */
export interface FiringOutcome {
  readonly outcome: Outcome | 'open'
  /** When it was read, in the board's words; absent while open. */
  readonly how?: string
  /** For a rewording, the firing that judged the new item. */
  readonly by?: string
}

export interface FiringView {
  readonly firing: Firing
  /** The rule's document, for the exact text a shadow firing would have delivered. */
  readonly source: string
  /** Absent for a firing nothing is followed on: a pass, a log, a block, a skip. */
  readonly came?: FiringOutcome
  readonly reaction?: Reaction & { readonly afterMs: number }
}

export interface Took {
  readonly p50: number
  readonly p95: number
}

export interface RuleRow {
  readonly rule: CatalogRule
  /** Events that reached the rule. */
  readonly admitted: number
  /** Of those, how many extracted nothing. */
  readonly nothingToJudge: number
  /** Items the rule decided on, the judge's or its own. */
  readonly decided: number
  /** Of those, how many the judge answered. */
  readonly judged: number
  /** Skips that mean the rule itself failed. */
  readonly broken: number
  /** Items the judge could not answer. */
  readonly unreachable: number
  readonly actions: Readonly<Partial<Record<RuleAction, number>>>
  readonly came: Readonly<Record<Outcome | 'open', number>>
  readonly took?: Took
  /** What the judge billed in the window, and that burn over a month. */
  readonly cost: { readonly dollars: number; readonly perMonth: number }
  readonly lastAt?: string
  /** Newest first. */
  readonly firings: readonly FiringView[]
}

export type Attention =
  | {
      readonly kind: 'rule'
      readonly rule: string
      readonly message: string
      readonly skips: number
      readonly trigger: string
      readonly since: string
      /** Still broken: nothing has run cleanly since. */
      readonly current: boolean
    }
  | {
      readonly kind: 'judge'
      readonly model: string
      readonly message: string
      readonly skips: number
      readonly from: string
      readonly to: string
      readonly fellBackTo: RuleAction
      readonly current: boolean
    }

export interface RulesBoard {
  readonly attention: readonly Attention[]
  readonly rules: readonly RuleRow[]
}

/** The chip in the top bar: how many rules, and whether anything is wrong now. */
export interface RulesHealth {
  readonly rules: number
  /** Rules broken now, and judges unreachable now. */
  readonly broken: number
  readonly judgeDown: boolean
  /** Open escalations: counted, never lit. */
  readonly escalated: number
  readonly lit: boolean
}

/** The ledger read once, for every question the board asks of it. */
export interface LedgerIndex {
  readonly catalog: readonly CatalogRule[]
  /** When the catalog was last written. */
  readonly catalogAt?: string
  /** Oldest first. */
  readonly firings: readonly FiringView[]
  readonly admitted: readonly Extract<LedgerLine, { type: 'admitted' }>[]
}

export function indexLedger(lines: readonly LedgerLine[]): LedgerIndex {
  let catalog: readonly CatalogRule[] = []
  let catalogAt: string | undefined
  const firings: Firing[] = []
  const outcomes = new Map<string, Extract<LedgerLine, { type: 'outcome' }>>()
  const reactions = new Map<string, Extract<LedgerLine, { type: 'reaction' }>>()
  const admitted: Extract<LedgerLine, { type: 'admitted' }>[] = []
  for (const line of lines) {
    if (line.type === 'catalog') {
      catalog = line.rules
      catalogAt = line.at
    } else if (line.type === 'firing') {
      firings.push(line)
    } else if (line.type === 'outcome') {
      if (!outcomes.has(line.firing)) outcomes.set(line.firing, line)
    } else if (line.type === 'reaction') {
      if (!reactions.has(line.firing)) reactions.set(line.firing, line)
    } else {
      admitted.push(line)
    }
  }
  const sources = new Map(catalog.map((rule) => [rule.name, rule.source]))
  return {
    catalog,
    ...(catalogAt === undefined ? {} : { catalogAt }),
    admitted,
    firings: firings.map((firing): FiringView => {
      const outcome = outcomes.get(firing.id)
      const reaction = reactions.get(firing.id)
      const came: FiringOutcome | undefined =
        outcome !== undefined
          ? { outcome: outcome.outcome, how: outcome.how, ...(outcome.by === undefined ? {} : { by: outcome.by }) }
          : tracksOutcome(firing) && firing.item !== undefined
            ? { outcome: 'open' }
            : undefined
      return {
        firing,
        source: sources.get(firing.rule) ?? '',
        ...(came === undefined ? {} : { came }),
        ...(reaction === undefined
          ? {}
          : {
              reaction: {
                afterMs: reaction.afterMs,
                ...(reaction.said === undefined ? {} : { said: reaction.said }),
                ...(reaction.then === undefined ? {} : { then: reaction.then })
              }
            })
      }
    })
  }
}

const DAY = 24 * 60 * 60 * 1000

/** Where the window starts, in ms. */
export function windowStart(window: BoardWindow, now: number): number {
  if (window === 'all') return Number.NEGATIVE_INFINITY
  if (window === 'today') {
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    return midnight.getTime()
  }
  return now - (window === '7d' ? 7 : 30) * DAY
}

export function inScope(agent: RuleAgentRef, scope: BoardScope): boolean {
  if (scope.kind === 'workspace') return true
  if (scope.kind === 'session') return agent.kind === 'session' && agent.sessionId === scope.sessionId
  return agent.kind === 'node' && agent.runId === scope.runId
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
}

function isBroken(firing: Firing): boolean {
  return firing.skip?.kind === 'threw' || firing.skip?.kind === 'over-budget'
}

/** Newest first, within a scope and a window. */
export function firingsIn(index: LedgerIndex, scope: BoardScope, from = Number.NEGATIVE_INFINITY): FiringView[] {
  return index.firings
    .filter((view) => inScope(view.firing.agent, scope) && Date.parse(view.firing.at) >= from)
    .reverse()
}

/** The counts every list of firings shows: what was decided, and what came of it. */
export function tally(firings: readonly FiringView[]): Pick<RuleRow, 'actions' | 'came' | 'took'> & {
  readonly dollars: number
} {
  const actions: Partial<Record<RuleAction, number>> = {}
  const came: Record<Outcome | 'open', number> = { fixed: 0, reworded: 0, open: 0, ignored: 0 }
  const took: number[] = []
  let dollars = 0
  for (const { firing, came: outcome } of firings) {
    if (firing.skip === undefined) {
      actions[firing.action] = (actions[firing.action] ?? 0) + 1
      took.push(firing.tookMs)
    }
    if (outcome !== undefined) came[outcome.outcome] += 1
    if (firing.judged !== undefined && !firing.judged.cached) dollars += firing.judged.dollars
  }
  took.sort((a, b) => a - b)
  return {
    actions,
    came,
    dollars,
    ...(took.length === 0 ? {} : { took: { p50: percentile(took, 0.5), p95: percentile(took, 0.95) } })
  }
}

export function rulesBoard(index: LedgerIndex, scope: BoardScope, window: BoardWindow, now: number): RulesBoard {
  const from = windowStart(window, now)
  const firings = firingsIn(index, scope, from)
  const admitted = index.admitted.filter((line) => inScope(line.agent, scope) && Date.parse(line.at) >= from)
  const earliest = Math.min(
    ...[...firings.map((view) => Date.parse(view.firing.at)), ...admitted.map((line) => Date.parse(line.at))],
    now
  )
  // A month of the burn this window shows, measured over the time it covers.
  const spanDays = Math.max((now - (Number.isFinite(from) ? from : earliest)) / DAY, 1 / 24)
  const rules = index.catalog.map((rule): RuleRow => {
    const mine = firings.filter((view) => view.firing.rule === rule.name)
    const reached = admitted.filter((line) => line.rule === rule.name)
    const counts = tally(mine)
    return {
      rule,
      admitted: reached.length,
      nothingToJudge: reached.filter((line) => line.items === 0).length,
      decided: mine.filter((view) => view.firing.skip === undefined).length,
      judged: mine.filter((view) => view.firing.judged !== undefined).length,
      broken: mine.filter((view) => isBroken(view.firing)).length,
      unreachable: mine.filter((view) => view.firing.skip?.kind === 'judge-unreachable').length,
      actions: counts.actions,
      came: counts.came,
      ...(counts.took === undefined ? {} : { took: counts.took }),
      cost: { dollars: counts.dollars, perMonth: (counts.dollars / spanDays) * 30 },
      ...(mine[0] === undefined ? {} : { lastAt: mine[0].firing.at }),
      firings: mine
    }
  })
  return { attention: attention(index, firings), rules }
}

function attention(index: LedgerIndex, newestFirst: readonly FiringView[]): Attention[] {
  const out: Attention[] = []
  for (const rule of index.catalog) {
    if (rule.held?.broken === true) {
      out.push({
        kind: 'rule',
        rule: rule.name,
        message: rule.held.message,
        skips: 0,
        trigger: rule.on,
        since: index.catalogAt ?? '',
        current: true
      })
      continue
    }
    const skips = newestFirst.filter((view) => view.firing.rule === rule.name && isBroken(view.firing))
    const latest = skips[0]
    if (latest === undefined) continue
    const cleanSince = index.admitted.some(
      (line) => line.rule === rule.name && Date.parse(line.at) > Date.parse(latest.firing.at)
    )
    out.push({
      kind: 'rule',
      rule: rule.name,
      message: latest.firing.skip!.message,
      skips: skips.length,
      trigger: rule.on,
      since: skips[skips.length - 1]!.firing.at,
      current: !cleanSince
    })
  }
  const byModel = new Map<string, FiringView[]>()
  for (const view of newestFirst) {
    if (view.firing.skip?.kind !== 'judge-unreachable') continue
    const model = index.catalog.find((rule) => rule.name === view.firing.rule)?.judge ?? 'the judge'
    byModel.set(model, [...(byModel.get(model) ?? []), view])
  }
  for (const [model, skips] of byModel) {
    const latest = skips[0]!
    const answeredSince = index.firings.some(
      (view) => view.firing.judged?.model === model && Date.parse(view.firing.at) > Date.parse(latest.firing.at)
    )
    out.push({
      kind: 'judge',
      model,
      message: latest.firing.skip!.message,
      skips: skips.length,
      from: skips[skips.length - 1]!.firing.at,
      to: latest.firing.at,
      fellBackTo: latest.firing.action,
      current: !answeredSince
    })
  }
  return out
}

/** The chip's facts, over the whole ledger: health is about now, not a window. */
export function rulesHealth(index: LedgerIndex): RulesHealth {
  const now = attention(index, [...index.firings].reverse()).filter((item) => item.current)
  const escalated = index.firings.filter(
    (view) => view.firing.action === 'escalate' && view.came?.outcome === 'open'
  ).length
  const judgeDown = now.some((item) => item.kind === 'judge')
  const broken = now.filter((item) => item.kind === 'rule').length
  return { rules: index.catalog.length, broken, judgeDown, escalated, lit: broken > 0 || judgeDown }
}

/** "0.41s", "3ms". */
export function formatTook(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`
}

/** "$0", "$0.00003", "$0.002", "$1.20". */
export function formatDollars(dollars: number): string {
  if (dollars === 0) return '$0'
  if (dollars >= 1) return `$${dollars.toFixed(2)}`
  const digits = Math.max(3, 1 - Math.floor(Math.log10(dollars)))
  return `$${dollars.toFixed(Math.min(digits, 6))}`
}

/** What a firing did, as its row and its mark say it. */
export function didLabel(firing: Firing): string {
  if (firing.skip !== undefined) return 'skipped'
  return firing.mode === 'shadow' ? `would ${firing.action}` : firing.action
}

/** How it reached the agent: "inline 0.38s", "steered 2.1s", or nothing. */
export function deliveryLabel(firing: Firing): string | undefined {
  if (firing.delivery === 'none') return undefined
  return `${firing.delivery} ${formatTook(firing.tookMs)}`
}
