import type { CacheRetention, RetentionSource, Unsubscribe } from '../agent/port'

// Beside the agent port, not behind it: the cache ledger is global, one file
// per installation across every workspace, session and run, and
// main-side code with no port still writes to it.

export type CacheHealthListener = (health: CacheHealth) => void

/** What the strip and the cache health view are drawn from. */
export interface CacheHealth {
  /** Misses since the last reset line. */
  readonly count: number
  /** Dollars re-billed since the last reset line. */
  readonly dollars: number
  /** ISO of the last reset line: the span the count covers. */
  readonly since: string
  /** Absolute, because handing it to an agent is the ledger's primary use. */
  readonly ledgerPath: string
  readonly retention: CacheRetention
  /** Whoever decided it, which is what "Retention in force" names. */
  readonly retentionSource: RetentionSource
}

export interface CacheService {
  read(): Promise<CacheHealth>
  /** Appends a reset line and answers with the counter as it stands after it. */
  reset(): Promise<CacheHealth>
  onChange(listener: CacheHealthListener): Unsubscribe
}

// Re-exported so a caller of this service names one module, the way the quota
// service's own `Unsubscribe` is spelled beside it.
export type { Unsubscribe }
