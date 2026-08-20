import type { SessionUsage, UsageLine } from '../../shared/agent/port'

// π reports usage per message and keeps no ledger, so the arithmetic is
// Crucible's; kept apart from the adapter so testing it costs nothing.

/** π's per-message `Usage`, with every field treated as possibly missing. */
export interface StoredUsage {
  readonly input?: number
  readonly output?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly totalTokens?: number
  readonly cost?: {
    readonly input?: number
    readonly output?: number
    readonly cacheRead?: number
    readonly cacheWrite?: number
    readonly total?: number
  }
}

interface Accumulator {
  tokens: number
  cost: number
}

function line(accumulated: Accumulator): UsageLine {
  return { tokens: accumulated.tokens, cost: accumulated.cost }
}

function number(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Every branch of the session tree is summed, because money spent does not
 * vanish on a jump. `undefined` is what a dash is shown for.
 */
export function sumUsage(usages: Iterable<StoredUsage | undefined>): SessionUsage | undefined {
  const input: Accumulator = { tokens: 0, cost: 0 }
  const output: Accumulator = { tokens: 0, cost: 0 }
  const cacheRead: Accumulator = { tokens: 0, cost: 0 }
  const cacheWrite: Accumulator = { tokens: 0, cost: 0 }
  let messages = 0
  let totalTokens = 0
  let totalCost = 0

  for (const usage of usages) {
    if (usage === undefined || usage === null) continue
    messages += 1

    input.tokens += number(usage.input)
    output.tokens += number(usage.output)
    cacheRead.tokens += number(usage.cacheRead)
    cacheWrite.tokens += number(usage.cacheWrite)

    input.cost += number(usage.cost?.input)
    output.cost += number(usage.cost?.output)
    cacheRead.cost += number(usage.cost?.cacheRead)
    cacheWrite.cost += number(usage.cost?.cacheWrite)

    // π's own totals when it gave them, the parts added up when it did not:
    // nothing here invents a number.
    totalTokens +=
      usage.totalTokens === undefined
        ? number(usage.input) +
          number(usage.output) +
          number(usage.cacheRead) +
          number(usage.cacheWrite)
        : number(usage.totalTokens)
    totalCost +=
      usage.cost?.total === undefined
        ? number(usage.cost?.input) +
          number(usage.cost?.output) +
          number(usage.cost?.cacheRead) +
          number(usage.cost?.cacheWrite)
        : number(usage.cost.total)
  }

  if (messages === 0) return undefined

  return {
    messages,
    input: line(input),
    output: line(output),
    cacheRead: line(cacheRead),
    cacheWrite: line(cacheWrite),
    totalTokens,
    totalCost
  }
}
