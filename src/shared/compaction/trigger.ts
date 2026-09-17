import type { CacheRetention } from '../agent/port'
import { cacheTtlMs } from '../cache/ttl.ts'
import type { CompactionTrigger } from './record.ts'
import { thresholdTokens, type CompactionSettings } from './settings.ts'
import { SMALLEST_WORTH_COMPACTING, WINDOW_EDGE_RESERVE_TOKENS } from './window.ts'

// When a conversation compacts. Pure predicates, so the same rules hold for a
// session's agent, the orchestrator and every workflow node without any of
// them owning a copy.

// How long before the cached prefix lapses the idle compaction runs. The
// summarizing request has to read the cache rather than re-bill it, and it
// needs time to finish, so it fires with this much of the retention left.
export const IDLE_MARGIN_MS = 10 * 60 * 1000

export interface ContextSize {
  readonly usedTokens: number
  /** The model's own window; zero or absent means nothing to measure against. */
  readonly contextWindow?: number
}

// The trigger a conversation's size calls for, or nothing. The edge is checked
// first: a conversation there compacts whatever the setting says, because the
// alternative is a conversation that cannot be sent to at all.
export function sizeTrigger(
  settings: CompactionSettings,
  size: ContextSize
): CompactionTrigger | undefined {
  if (size.usedTokens < SMALLEST_WORTH_COMPACTING) return undefined
  const window = size.contextWindow ?? 0
  if (window > 0 && size.usedTokens >= window - WINDOW_EDGE_RESERVE_TOKENS) return 'windowEdge'
  if (!settings.enabled) return undefined
  return size.usedTokens >= thresholdTokens(settings) ? 'threshold' : undefined
}

// How long a conversation may sit before it is compacted on its cache's
// account. Absent under five-minute retention: there is no margin to fit a
// summarizing request into, so the idle rule does not exist.
export function idleCompactionDelayMs(retention: CacheRetention): number | undefined {
  const ttl = cacheTtlMs(retention)
  return ttl <= IDLE_MARGIN_MS ? undefined : ttl - IDLE_MARGIN_MS
}

export interface IdleFacts {
  /** Epoch ms of the conversation's last billed request. */
  readonly lastRequestAt: number
  readonly usedTokens: number
  readonly retention: CacheRetention
}

// Whether the quiet has run long enough, with a warm cache and something
// worth compacting behind it. The switch does not gate this one: the idle
// compaction is about the cache rather than about the context size, and it
// runs on exactly the conversations the setting would never reach.
export function idleTrigger(facts: IdleFacts, now: number): 'idle' | undefined {
  const delay = idleCompactionDelayMs(facts.retention)
  if (delay === undefined) return undefined
  if (facts.usedTokens < SMALLEST_WORTH_COMPACTING) return undefined
  const waited = now - facts.lastRequestAt
  // Past the retention the prefix is already gone, so the request this would
  // make would re-bill the conversation rather than read it.
  if (waited < delay || waited >= cacheTtlMs(facts.retention)) return undefined
  return 'idle'
}
