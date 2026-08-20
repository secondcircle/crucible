import { readdirSync, readFileSync } from 'node:fs'
import { isLive } from '../../shared/quota/freshness'
import type { ProviderQuota, QuotaError, QuotaMeter, QuotaSnapshot } from '../../shared/quota/types'
import {
  CACHE_SCHEMA_VERSION,
  cacheFile,
  isSafeProviderId,
  KNOWN_PROVIDER_IDS,
  quotaCacheDir
} from './paths'

/**
 * The pure half of the quota plumbing: it reads cache files, never fetches,
 * never locks, never watches, and imports neither the store, the adapters, nor
 * π. This is the seam a future model switcher crosses — the whole reason the
 * halves are split — so asking it a question can never cost a request.
 *
 * Hidden behind it: the file layout, lapsed suppression, schema versioning. A
 * caller need not know a store exists; a machine where nothing has ever fetched
 * reads an empty snapshot, which is `null` at every consumer API, never a zero.
 */

// The freshness vocabulary is one module's, shared with the strip. Re-exported
// here so a consumer of the read seam has one import and no way to reach for a
// second definition of "stale".
export {
  isStale,
  worstUsedPercent,
  STALE_AFTER_MS,
  MAX_USABLE_AGE_MS
} from '../../shared/quota/freshness'

/**
 * One cache file. The published record calls the list `meters`; the disk keeps
 * the legacy system's field name `windows` verbatim, because the file is an
 * interop contract with apps this one does not control. The mapping happens
 * here, at the read/write boundary, and nowhere else.
 *
 * `attemptedAt` is when the last *attempt* happened; `fetchedAt` is how old the
 * *data* is. Keeping them apart is what lets a failure age a reading visibly
 * (`·12m`) while the TTL still suppresses a retry storm against a provider that
 * is down.
 */
export interface CacheEntry {
  readonly v: number
  readonly providerId: string
  readonly windows: readonly QuotaMeter[]
  readonly fetchedAt: number
  readonly attemptedAt: number
  readonly error?: QuotaError
  /**
   * A nonce stamped by whoever published this file, new on every write.
   *
   * It answers one question no timestamp can answer reliably: did somebody
   * write this file while I was away? Two passes may carry the same injected
   * clock (the store's documented test seam) or simply land in the same
   * millisecond, and then equal `attemptedAt` values say nothing about whether
   * a write happened. A fresh random token per write says it exactly, without a
   * clock and across processes.
   *
   * It carries no identity — it is random, and it is about the *file*. Absent
   * in files written before this field existed, which reads as "unknown writer"
   * and falls back to the `attemptedAt` comparison.
   */
  readonly writeId?: string
}

const KINDS = new Set<QuotaMeter['kind']>(['session', 'weekly', 'weekly_scoped'])
const ERRORS = new Set<string>(['unauthorized', 'unavailable', 'unparsed'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A meter is only as trustworthy as its own fields: a cache file is data from
 * outside this process, so it is validated exactly as a payload is.
 */
function validMeter(raw: unknown): QuotaMeter | null {
  if (!isRecord(raw)) return null
  const kind = raw['kind']
  const label = raw['label']
  const usedPercent = raw['usedPercent']
  const resetsAt = raw['resetsAt']
  if (typeof kind !== 'string' || !KINDS.has(kind as QuotaMeter['kind'])) return null
  if (typeof label !== 'string' || label.length === 0) return null
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return null
  if (usedPercent < 0 || usedPercent > 100) return null
  if (resetsAt !== null && (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt))) return null

  return {
    kind: kind as QuotaMeter['kind'],
    label,
    usedPercent,
    resetsAt: resetsAt as number | null,
    ...(typeof raw['scopeName'] === 'string' ? { scopeName: raw['scopeName'] } : {}),
    ...(typeof raw['isActive'] === 'boolean' ? { isActive: raw['isActive'] } : {})
  }
}

function validEntry(raw: unknown, providerId: string): CacheEntry | null {
  if (!isRecord(raw)) return null
  // A schema change bumps `v`; readers discard on mismatch and refetch. No
  // in-place migration, ever — the data is a cache and refetching costs one GET.
  if (raw['v'] !== CACHE_SCHEMA_VERSION) return null
  if (raw['providerId'] !== providerId) return null
  if (typeof raw['fetchedAt'] !== 'number' || !Number.isFinite(raw['fetchedAt'])) return null
  if (!Array.isArray(raw['windows'])) return null
  const error = raw['error']
  if (error !== undefined && (typeof error !== 'string' || !ERRORS.has(error))) return null

  const windows: QuotaMeter[] = []
  for (const candidate of raw['windows']) {
    const meter = validMeter(candidate)
    if (meter) windows.push(meter)
  }

  return {
    v: CACHE_SCHEMA_VERSION,
    providerId,
    windows,
    fetchedAt: raw['fetchedAt'],
    attemptedAt: typeof raw['attemptedAt'] === 'number' ? raw['attemptedAt'] : raw['fetchedAt'],
    ...(typeof error === 'string' ? { error: error as QuotaError } : {}),
    // Bookkeeping, never published: `readQuota()` below builds its records
    // field by field, so this reaches the store and nothing else.
    ...(typeof raw['writeId'] === 'string' ? { writeId: raw['writeId'] } : {})
  }
}

/**
 * One provider's cache file, or `null`. Missing, truncated, unparseable, or a
 * schema mismatch all read as absent and never throw — a half-written file
 * cannot be observed (atomic rename), so this means external damage.
 */
export function readEntry(providerId: string, dir?: string): CacheEntry | null {
  if (!isSafeProviderId(providerId)) return null
  try {
    return validEntry(JSON.parse(readFileSync(cacheFile(providerId, dir), 'utf8')), providerId)
  } catch {
    return null
  }
}

/**
 * Every provider id with a cache file present, in directory order — including
 * ids no adapter owns. Exported for the store, which prunes exactly those; the
 * snapshot below is narrower.
 */
export function cachedProviderIds(dir?: string): string[] {
  try {
    return readdirSync(quotaCacheDir(dir))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter(isSafeProviderId)
  } catch {
    return []
  }
}

/**
 * The latest snapshot off disk. Never fetches, never locks, never throws.
 *
 * Lapsed meters — those whose reset instant has already passed — are dropped
 * here rather than dimmed: the quota has rolled over, so the cached percentage
 * is wrong rather than merely old, and a lapsed percent is the one failure that
 * looks exactly like a correct reading. A provider whose every meter has lapsed
 * stays present with an empty list, which renders as its name and `—`.
 */
export function readQuota(opts: { dir?: string; now?: () => number } = {}): QuotaSnapshot {
  const now = opts.now ?? Date.now
  const at = now()
  const providers: Record<string, ProviderQuota> = {}
  // A provider with no adapter is absent, and that has to hold for THIS read:
  // the strip paints its first snapshot from the cache before any refresh has
  // had the chance to prune residue. Filtering here is what makes absence a
  // property of the reader rather than of timing.
  for (const providerId of cachedProviderIds(opts.dir).filter((id) =>
    KNOWN_PROVIDER_IDS.includes(id)
  )) {
    const entry = readEntry(providerId, opts.dir)
    if (entry === null) continue
    providers[providerId] = {
      providerId: entry.providerId,
      meters: entry.windows.filter((meter) => isLive(meter, at)),
      fetchedAt: entry.fetchedAt,
      ...(entry.error === undefined ? {} : { error: entry.error })
    }
  }
  return { providers, fetchedAt: at }
}

/** The directory the reader reads. Exported for diagnostics. */
export function quotaCacheDirectory(dir?: string): string {
  return quotaCacheDir(dir)
}
