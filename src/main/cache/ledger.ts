import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CacheMissChanges } from '../../shared/agent/adapter'
import type { CacheRetention, ThinkingLevel, Unsubscribe } from '../../shared/agent/port'
import type { CacheHealth, CacheHealthListener, CacheService } from '../../shared/cache/service'
import { cacheLedgerPath } from './paths'
import { retentionInForce } from './retention'

// The cache ledger: one append-only JSONL file recording every cache miss
// Crucible observes, plus a line for each counter reset. Permanent and never
// pruned — the questions it answers are longitudinal, and a miss
// filtered out as uninteresting is a hole in exactly the evidence being
// reasoned over. An agent reads this file, so the line schema below is a
// product contract rather than an implementation detail.

/** The schema version every line this build writes carries. */
export const LEDGER_VERSION = 1

/** Where a miss happened: a curated session, or a node of a workflow run. */
export type CacheMissSource =
  | {
      readonly kind: 'session'
      readonly sessionId: string
      /** The session's title at the moment of the miss; absent while untitled. */
      readonly title?: string
      /** The workspace path, not the worktree. */
      readonly workspace: string
    }
  | {
      readonly kind: 'run'
      readonly runId: string
      readonly workflow: string
      readonly node: string
      readonly workspace: string
    }

// One miss as its observer composed it. The recording service stamps the
// version, the type and the retention in force; nothing else is added, and no
// cause is inferred anywhere.
export interface RecordedCacheMiss {
  /** ISO of the moment the paying message completed. */
  readonly at: string
  readonly source: CacheMissSource
  readonly provider: string
  readonly model: string
  readonly thinkingLevel?: ThinkingLevel
  readonly tokensRebilled: number
  readonly dollarsRebilled: number
  readonly gapMs: number
  readonly changed: CacheMissChanges
}

/** What main writes to; the renderer never sees a ledger line. */
export interface CacheRecorder {
  /** The setting recorded against every entry this launch writes. */
  readonly retention: CacheRetention
  readonly ledgerPath: string
  /** Never rejects: a ledger that cannot be written must not fail a turn. */
  append(miss: RecordedCacheMiss): Promise<void>
}

export interface CacheLedger extends CacheRecorder, CacheService {}

export interface CacheLedgerOptions {
  // The state directory the file lives directly under. Absent means the one
  // main configured, and an unconfigured launch throws rather than guessing.
  readonly dir?: string
  readonly retention?: CacheRetention
  /** A write nobody is waiting on still deserves a line in the run log. */
  readonly onFailure?: (cause: unknown) => void
  /** Overridden by tests that need a reset line at an instant of their own. */
  readonly clock?: () => string
}

interface ParsedLine {
  readonly v?: unknown
  readonly type?: unknown
  readonly at?: unknown
  readonly dollarsRebilled?: unknown
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Rounded to a hundredth of a cent, so a sum of floats carries no tail. */
function round(dollars: number): number {
  return Math.round(dollars * 10_000) / 10_000
}

export function createCacheLedger(options: CacheLedgerOptions = {}): CacheLedger {
  const path = cacheLedgerPath(options.dir)
  const retention = options.retention ?? retentionInForce()
  const now = options.clock ?? ((): string => new Date().toISOString())
  const listeners = new Set<CacheHealthListener>()
  // Sessions run concurrently, so appends are serialized here: one
  // complete JSON line per write. Different flavors write different files, so
  // there is no cross-process contention to solve.
  let queue: Promise<unknown> = Promise.resolve()
  let created = false

  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work)
    // The chain must survive a rejected operation, or every later append
    // would inherit its failure.
    queue = next.catch(() => {})
    return next
  }

  function line(entry: Record<string, unknown>): string {
    return `${JSON.stringify(entry)}\n`
  }

  function resetLine(at: string): string {
    return line({ v: LEDGER_VERSION, type: 'reset', at })
  }

  // The file is created the first time the service touches it, and creation
  // writes an initial reset line: the strip's "since" is defined even on a
  // virgin install.
  async function ensureFile(): Promise<void> {
    if (created) return
    await mkdir(dirname(path), { recursive: true })
    try {
      await appendFile(path, '', { flag: 'wx' })
      await appendFile(path, resetLine(now()))
    } catch (cause) {
      // Already there is the ordinary case: the ledger outlives every launch.
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
    }
    created = true
  }

  async function health(): Promise<CacheHealth> {
    await ensureFile()
    let since: string | undefined
    let earliestMiss: string | undefined
    let count = 0
    let dollars = 0

    const content = await readFile(path, 'utf8')
    for (const raw of content.split('\n')) {
      if (raw.trim() === '') continue
      let parsed: ParsedLine
      try {
        parsed = JSON.parse(raw) as ParsedLine
      } catch {
        // A permanent file has to survive its own future: a line this build
        // cannot read is skipped and the count goes on.
        continue
      }
      if (typeof parsed !== 'object' || parsed === null) continue
      if (parsed.v !== LEDGER_VERSION) continue
      if (parsed.type === 'reset' && typeof parsed.at === 'string') {
        since = parsed.at
        count = 0
        dollars = 0
        continue
      }
      if (parsed.type !== 'miss') continue
      count += 1
      dollars += number(parsed.dollarsRebilled)
      if (typeof parsed.at === 'string' && earliestMiss === undefined) earliestMiss = parsed.at
    }

    return {
      count,
      dollars: round(dollars),
      // With no reset line in the file at all — someone edited it — the span
      // is honestly the oldest miss still in it.
      since: since ?? earliestMiss ?? now(),
      ledgerPath: path,
      retention
    }
  }

  async function announce(): Promise<CacheHealth> {
    const current = await health()
    for (const listener of [...listeners]) listener(current)
    return current
  }

  return {
    retention,
    ledgerPath: path,

    async append(miss: RecordedCacheMiss): Promise<void> {
      await serialize(async () => {
        try {
          await ensureFile()
          await appendFile(
            path,
            line({
              v: LEDGER_VERSION,
              type: 'miss',
              at: miss.at,
              source: miss.source,
              provider: miss.provider,
              model: miss.model,
              ...(miss.thinkingLevel === undefined ? {} : { thinkingLevel: miss.thinkingLevel }),
              retention,
              tokensRebilled: miss.tokensRebilled,
              dollarsRebilled: miss.dollarsRebilled,
              gapMs: miss.gapMs,
              changed: miss.changed
            })
          )
          await announce()
        } catch (cause) {
          // Nobody is waiting on this write: a turn is not failed because the
          // evidence file could not be extended.
          options.onFailure?.(cause)
        }
      })
    },

    read(): Promise<CacheHealth> {
      return serialize(health)
    },

    // Appends a reset line and deletes nothing, which is what makes "since we
    // changed that setting" a query rather than a memory.
    reset(): Promise<CacheHealth> {
      return serialize(async () => {
        await ensureFile()
        await appendFile(path, resetLine(now()))
        return announce()
      })
    },

    onChange(listener: CacheHealthListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
