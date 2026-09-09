import { appendFile, mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CacheMissChanges } from '../../shared/agent/adapter'
import type { CacheRetention, ThinkingLevel, Unsubscribe } from '../../shared/agent/port'
import type { CacheHealth, CacheHealthListener, CacheService } from '../../shared/cache/service'
import { cacheLedgerPath } from './paths'
import { retentionInForce, type RetentionDecision } from './retention'

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
  // The cache expiry choice named this re-bill before the send and the person
  // took "send anyway". Still a miss, still evidence, still on the line: what
  // it is not is a surprise, so the strip leaves it out of its count.
  readonly acknowledged?: true
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
  // Overridden by tests that record against a setting of their own; absent
  // means the decision the retention module made for this launch.
  readonly retention?: RetentionDecision
  /** A write nobody is waiting on still deserves a line in the run log. */
  readonly onFailure?: (cause: unknown) => void
  /** Overridden by tests that need a reset line at an instant of their own. */
  readonly clock?: () => string
}

interface ParsedLine {
  readonly v?: unknown
  readonly type?: unknown
  readonly at?: unknown
  readonly acknowledged?: unknown
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
  const decision = options.retention ?? retentionInForce()
  const { retention } = decision
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

  // The counter as the lines read so far leave it. The file is append-only and
  // the fold is a fold, so every pass only has to read what arrived since the
  // last one: at 200,000 misses a full re-parse was 236 ms, and it ran after
  // every single recorded miss.
  let since: string | undefined
  let earliestMiss: string | undefined
  let count = 0
  let dollars = 0
  /** Bytes already folded in. */
  let read = 0
  /** A trailing line another writer had not finished when we last looked. */
  let carry = Buffer.alloc(0)

  function foldLine(raw: string): void {
    if (raw.trim() === '') return
    let parsed: ParsedLine
    try {
      parsed = JSON.parse(raw) as ParsedLine
    } catch {
      // A permanent file has to survive its own future: a line this build
      // cannot read is skipped and the count goes on.
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    if (parsed.v !== LEDGER_VERSION) return
    if (parsed.type === 'reset' && typeof parsed.at === 'string') {
      since = parsed.at
      count = 0
      dollars = 0
      return
    }
    if (parsed.type !== 'miss') return
    if (typeof parsed.at === 'string' && earliestMiss === undefined) earliestMiss = parsed.at
    // The strip exists to say when a miss happened that nobody saw coming.
    // One the person chose with the price in front of them stays in the
    // file and off the counter.
    if (parsed.acknowledged === true) return
    count += 1
    dollars += number(parsed.dollarsRebilled)
  }

  /**
   * Folds in whatever was appended since the last pass, whoever appended it.
   * A file that shrank was replaced rather than appended to, so it is folded
   * again from the start.
   */
  async function absorb(): Promise<void> {
    const handle = await open(path, 'r')
    try {
      const { size } = await handle.stat()
      if (size < read) {
        since = undefined
        earliestMiss = undefined
        count = 0
        dollars = 0
        read = 0
        carry = Buffer.alloc(0)
      }
      if (size === read) return
      const buffer = Buffer.allocUnsafe(size - read)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, read)
      read += bytesRead
      const chunk = Buffer.concat([carry, buffer.subarray(0, bytesRead)])
      let start = 0
      for (;;) {
        const newline = chunk.indexOf(0x0a, start)
        if (newline === -1) break
        foldLine(chunk.toString('utf8', start, newline))
        start = newline + 1
      }
      // Held whole, bytes not characters, so a line split across two passes
      // never loses a multi-byte character at the seam.
      carry = Buffer.from(chunk.subarray(start))
    } finally {
      await handle.close()
    }
  }

  async function health(): Promise<CacheHealth> {
    await ensureFile()
    await absorb()

    return {
      count,
      dollars: round(dollars),
      // With no reset line in the file at all — someone edited it — the span
      // is honestly the oldest miss still in it.
      since: since ?? earliestMiss ?? now(),
      ledgerPath: path,
      retention,
      retentionSource: decision.source
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
              ...(miss.acknowledged === true ? { acknowledged: true } : {}),
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
