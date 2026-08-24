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

// Split from the store so that asking about quota can never cost a request:
// nothing here fetches, locks or imports π.

// Re-exported so a consumer of this seam has one import and no way to reach
// for a second definition of "stale".
export {
  isStale,
  worstUsedPercent,
  STALE_AFTER_MS,
  MAX_USABLE_AGE_MS
} from '../../shared/quota/freshness'

// The disk keeps the field name `windows` verbatim, because the file is an
// interop contract with apps this one does not control. The published record's
// `meters` is mapped here and nowhere else.
export interface CacheEntry {
  readonly v: number
  readonly providerId: string
  readonly windows: readonly QuotaMeter[]
  /** How old the data is, as against when it was last attempted: a failure
   * ages a reading visibly while the TTL still suppresses a retry storm. */
  readonly fetchedAt: number
  readonly attemptedAt: number
  readonly error?: QuotaError
  /**
   * Random, new on every write: two passes can share a clock or a millisecond,
   * so equal timestamps cannot say whether somebody wrote while we were away.
   * Absent in older files, which falls back to comparing `attemptedAt`.
   */
  readonly writeId?: string
}

const KINDS = new Set<QuotaMeter['kind']>(['session', 'weekly', 'weekly_scoped', 'monthly'])
const ERRORS = new Set<string>(['unauthorized', 'unavailable', 'unparsed'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The spend meter's two amounts, in major currency units. `null` where either
 * one fails, because a meter that prints one real number beside a missing one
 * is worse than no meter: the reader cannot tell a fabricated zero from an
 * amount somebody actually spent.
 */
function validDollars(
  used: unknown,
  limit: unknown
): { usedDollars: number; limitDollars: number } | null {
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null
  // A zero budget divides into nothing, so the percent the strip prints from
  // these two would be a fabrication of its own.
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return null
  return { usedDollars: used, limitDollars: limit }
}

// A cache file is data from outside this process, so it is validated exactly
// as a payload is.
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

  // Dollars come through exactly where the published contract promises them:
  // a monthly meter carries both amounts or is dropped whole, and no other
  // kind carries them whatever the file says.
  let dollars: { usedDollars: number; limitDollars: number } | null = null
  if (kind === 'monthly') {
    dollars = validDollars(raw['usedDollars'], raw['limitDollars'])
    if (dollars === null) return null
  }

  return {
    kind: kind as QuotaMeter['kind'],
    label,
    usedPercent,
    resetsAt: resetsAt as number | null,
    ...(dollars ?? {}),
    ...(typeof raw['scopeName'] === 'string' ? { scopeName: raw['scopeName'] } : {}),
    ...(typeof raw['isActive'] === 'boolean' ? { isActive: raw['isActive'] } : {})
  }
}

function validEntry(raw: unknown, providerId: string): CacheEntry | null {
  if (!isRecord(raw)) return null
  // Never migrated in place: the data is a cache, and refetching costs one GET.
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
    // Never published: the snapshot below is built field by field, so this
    // reaches the store and nothing else.
    ...(typeof raw['writeId'] === 'string' ? { writeId: raw['writeId'] } : {})
  }
}

/** Damage reads as absence and never throws; writes are atomic, so it is damage. */
export function readEntry(providerId: string, dir?: string): CacheEntry | null {
  if (!isSafeProviderId(providerId)) return null
  try {
    return validEntry(JSON.parse(readFileSync(cacheFile(providerId, dir), 'utf8')), providerId)
  } catch {
    return null
  }
}

/** Includes ids no adapter owns, because the store prunes exactly those. */
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

// Lapsed meters are dropped rather than dimmed: the quota has rolled over, so
// the cached percentage is wrong rather than merely old.
export function readQuota(opts: { dir?: string; now?: () => number } = {}): QuotaSnapshot {
  const now = opts.now ?? Date.now
  const at = now()
  const providers: Record<string, ProviderQuota> = {}
  // Filtered here as well as pruned by the store: the strip paints its first
  // snapshot before any refresh has had the chance to remove residue.
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

export function quotaCacheDirectory(dir?: string): string {
  return quotaCacheDir(dir)
}
