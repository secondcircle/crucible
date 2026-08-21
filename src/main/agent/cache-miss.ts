import type { StoredUsage } from './usage'

// π's cache-miss arithmetic, mirrored. π does not export `core/cache-stats`
// through its package entry, so Crucible owns the definition rather than
// reaching into the SDK's files for it: same arithmetic, same constants, no
// SDK import, provable with plain data.
//
// The reference implementation is
// node_modules/@earendil-works/pi-coding-agent/dist/core/cache-stats.js.
// π's separate display threshold (20k tokens or $0.10) is deliberately not
// mirrored: Crucible records every miss past the noise floor and judges none.

/** π's `NOISE_FLOOR_TOKENS`: at or below this, a "miss" is breakpoint granularity. */
export const NOISE_FLOOR_TOKENS = 1024

// π's `CACHE_TTL_MS`: Anthropic's default prompt-cache lifetime, and the gap
// past which π's own notice blames an idle expiry. No arithmetic below reads
// it, because Crucible blames nothing and exempts nothing — a miss on a
// conversation resumed after eight hours is the datum the ledger exists to
// hold. It is kept beside the floor because this module is where π's
// constants live, and because `PI_CACHE_RETENTION=long` moves it to an hour,
// which is the question the ledger is being read to answer.
export const CACHE_TTL_MS = 5 * 60 * 1000

/** One completed assistant message, as the mirror reads it. */
export interface CacheMessage {
  readonly provider: string
  readonly model: string
  /** Epoch milliseconds, π's own stamp. */
  readonly timestamp: number
  readonly usage?: StoredUsage
}

/** What one detected miss is worth, before anything names where it happened. */
export interface DetectedCacheMiss {
  readonly missedTokens: number
  readonly missedCost: number
  /** Since the previous request; never negative. */
  readonly gapMs: number
  readonly modelChanged: boolean
}

/** The turn a message is compared against: π's `PreviousRequest`. */
export interface PreviousRequest {
  readonly promptTokens: number
  /** `provider/model`. */
  readonly modelKey: string
  readonly timestamp: number
  /** Whether this conversation has ever reported cache activity. */
  readonly reportedCache: boolean
}

// One item of a conversation, in the order it happened. `other` earns its
// place so an index into a scan still names the caller's own item.
export type CacheScanEntry =
  /** A completed assistant message: the only thing a miss is detected on. */
  | { readonly kind: 'assistant'; readonly message: CacheMessage }
  /** A compaction or a branch summary, after which the prompt is new content. */
  | { readonly kind: 'contextReset' }
  | { readonly kind: 'other' }

export interface CacheMissTotals {
  readonly count: number
  readonly tokens: number
  readonly dollars: number
}

export interface ScannedCacheMiss {
  /** Index into the scanned sequence: the entry that paid for this miss. */
  readonly at: number
  readonly miss: DetectedCacheMiss
}

export interface CacheScan {
  readonly totals: CacheMissTotals
  readonly misses: readonly ScannedCacheMiss[]
  // Positioned after everything scanned, so the next completed message is
  // observed against it. This is how a restored conversation continues
  // counting where it left off.
  readonly tracker: CacheMissTracker
}

export interface CacheMissTrackerOptions {
  // The model's listed cache-read price per million tokens, used only when
  // this message paid for no cache read of its own. Absent means zero, which
  // is what π falls back to for a model it cannot price.
  readonly listedCacheReadPerMillion?: (provider: string, model: string) => number | undefined
}

// The comparison state of one conversation, fed message by message. The live
// path and the rebuild-from-history path are the same code: at bind the
// stored messages go through in order, and detection continues from there.
export interface CacheMissTracker {
  /** Answers with the miss this message paid for, if it paid for one. */
  observe(message: CacheMessage): DetectedCacheMiss | undefined
  // A compaction or a branch summary: the context legitimately changed, so
  // the next turn's prompt is new content rather than re-billed content.
  // Model switches are NOT exempt — they re-bill the full prompt.
  contextReset(): void
}

function number(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function promptTokensOf(usage: StoredUsage): number {
  return number(usage.input) + number(usage.cacheRead) + number(usage.cacheWrite)
}

// Whether this message is a request anything can be compared against: π's
// `asPreviousRequest` counts a message with no billed prompt as nothing at
// all, and the turn before it goes on standing.
export function billsPrompt(message: CacheMessage): boolean {
  return message.usage !== undefined && promptTokensOf(message.usage) > 0
}

export function createCacheMissTracker(
  options: CacheMissTrackerOptions = {}
): CacheMissTracker {
  let previous: PreviousRequest | undefined

  function readRate(message: CacheMessage, usage: StoredUsage): number {
    const cacheRead = number(usage.cacheRead)
    // This message's own paid rate first: it is the only rate that is
    // certainly the one it was billed at.
    if (cacheRead > 0) return number(usage.cost?.cacheRead) / cacheRead
    const listed = options.listedCacheReadPerMillion?.(message.provider, message.model)
    return number(listed) / 1_000_000
  }

  function detect(message: CacheMessage): DetectedCacheMiss | undefined {
    const usage = message.usage
    if (usage === undefined) return undefined
    const promptTokens = promptTokensOf(usage)
    const cacheRead = number(usage.cacheRead)
    const cacheWrite = number(usage.cacheWrite)
    // Nothing to compare against, nothing billed, or a provider that has
    // never reported caching at all: a provider that never caches is not
    // missing.
    if (
      previous === undefined ||
      promptTokens <= 0 ||
      (cacheRead + cacheWrite === 0 && !previous.reportedCache)
    ) {
      return undefined
    }

    const missedTokens = Math.min(previous.promptTokens, promptTokens) - cacheRead
    if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined

    // Missed tokens can only land in the input or cacheWrite buckets, so the
    // rate they were really billed at comes from this message's own cost
    // breakdown, write premium included.
    const paidTokens = number(usage.input) + cacheWrite
    const paidPerToken =
      paidTokens > 0 ? (number(usage.cost?.input) + number(usage.cost?.cacheWrite)) / paidTokens : 0
    const readPerToken = readRate(message, usage)

    return {
      missedTokens,
      missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
      gapMs: Math.max(0, message.timestamp - previous.timestamp),
      modelChanged: `${message.provider}/${message.model}` !== previous.modelKey
    }
  }

  return {
    observe(message: CacheMessage): DetectedCacheMiss | undefined {
      const miss = detect(message)
      const usage = message.usage
      // A message that billed no prompt at all is not a request anything can
      // be compared against, so the previous one goes on standing.
      if (usage !== undefined && billsPrompt(message)) {
        previous = {
          promptTokens: promptTokensOf(usage),
          modelKey: `${message.provider}/${message.model}`,
          timestamp: message.timestamp,
          // Once this conversation has cached anything, a later turn that
          // reads nothing back is a total miss rather than a provider that
          // does not cache.
          reportedCache:
            (previous?.reportedCache ?? false) ||
            number(usage.cacheRead) + number(usage.cacheWrite) > 0
        }
      }
      return miss
    },

    contextReset(): void {
      previous = undefined
    }
  }
}

// One pass over a conversation: the totals it has paid, where each miss
// landed, and the state the next message will be compared against.
export function scanCacheMisses(
  entries: readonly CacheScanEntry[],
  options: CacheMissTrackerOptions = {}
): CacheScan {
  const tracker = createCacheMissTracker(options)
  const misses: ScannedCacheMiss[] = []
  let count = 0
  let tokens = 0
  let dollars = 0

  entries.forEach((entry, at) => {
    if (entry.kind === 'contextReset') {
      tracker.contextReset()
      return
    }
    if (entry.kind !== 'assistant') return
    const miss = tracker.observe(entry.message)
    if (miss === undefined) return
    misses.push({ at, miss })
    count += 1
    tokens += miss.missedTokens
    dollars += miss.missedCost
  })

  // Rounded to a hundredth of a cent, so a sum of floats carries no tail.
  return {
    totals: { count, tokens, dollars: Math.round(dollars * 10_000) / 10_000 },
    misses,
    tracker
  }
}
