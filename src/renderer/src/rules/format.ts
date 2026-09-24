import { deliveryLabel, didLabel, type FiringView } from '../../../shared/rules/board'
import type { Firing, RuleAgentRef } from '../../../shared/rules/ledger'

// The words a firing is shown in, wherever it is shown: a board row, the
// rules tab, a mark on a tool call.

/** The class a firing's "did" cell is tinted by. */
export function didTone(firing: Firing): string {
  if (firing.skip !== undefined) return 'skip'
  if (firing.mode === 'shadow') return 'shadow'
  return firing.action === 'escalate' ? 'esc' : firing.action
}

/** `§ comments · note`, `§ comments · would note`, `§ comments · skipped`. */
export function markText(firing: Firing): string {
  return `§ ${firing.rule} · ${didLabel(firing)}`
}

/** Where it happened: the item's spot, else the file or command. */
export function spotText(firing: Firing): string {
  const item = firing.item
  if (item === undefined || item.path === '') return firing.where
  return item.line > 0 ? `${item.path}:${item.line}` : item.path
}

/** The short tail after the spot: the item's first line, or why it was skipped. */
export function snippetText(firing: Firing): string | undefined {
  if (firing.skip !== undefined) return firing.skip.message
  const focus = firing.item?.excerpt?.focus
  if (focus !== undefined) {
    const first = focus.split('\n')[0]!.trim()
    return first.length > 64 ? `${first.slice(0, 63)}…` : first
  }
  const state = firing.item?.state
  return typeof state === 'string' ? state.slice(0, 64) : undefined
}

/** What came of it, as the cell says it. */
export function cameText(view: FiringView): { readonly text: string; readonly tone: string } {
  if (view.came === undefined) return { text: '—', tone: 'none' }
  return { text: view.came.outcome, tone: view.came.outcome }
}

export function deliveredText(firing: Firing): string {
  return deliveryLabel(firing) ?? '—'
}

/** Which agent a firing came from, in the board's "in" column. */
export function agentText(agent: RuleAgentRef, sessionTitle: (sessionId: string) => string | undefined): {
  readonly run?: string
  readonly text: string
} {
  if (agent.kind === 'session') return { text: sessionTitle(agent.sessionId) ?? 'a session' }
  return { run: agent.runId, text: agent.nodeId }
}

/** The command that explains this firing's item in a terminal; absent where none can. */
export function explainCommand(firing: Firing): string | undefined {
  if (firing.trigger === 'edit' && firing.item !== undefined && firing.item.line > 0) {
    return `crucible rules explain ${firing.rule} ${firing.item.path}:${firing.item.line}`
  }
  if (firing.trigger === 'bash') {
    return `crucible rules explain ${firing.rule} --command '${firing.where.replace(/'/g, `'\\''`)}'`
  }
  return undefined
}
