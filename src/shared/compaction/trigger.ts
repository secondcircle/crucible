import type { CacheRetention } from '../agent/port'
import { cacheTtlMs } from '../cache/ttl.ts'
import type { CompactionTrigger } from './record.ts'
import { thresholdTokens, type CompactionSettings } from './settings.ts'
import { smallestWorthCompacting, windowEdgeReserveTokens } from './window.ts'

// When a conversation compacts. Pure predicates, so the same rules hold for a
// session's agent, the orchestrator and every workflow node without any of
// them owning a copy.

// What this conversation's own last compaction left it at, where it has
// compacted at all. Every rule here needs it: the size alone says how big the
// conversation is, and this says how much of that a compaction could take
// away. A conversation sitting on the result of its own last compaction gains
// nothing from another, however far over the threshold that result is.
//
// It comes from the conversation, beside the size and from the same report,
// because it is written down with the conversation: the rule answers the same
// way in the launch that compacted and in every launch after it.
export interface CompactionHistory {
  readonly compactedTo?: number
}

// How long before the cached prefix lapses the idle compaction runs. The
// summarizing request has to read the cache rather than re-bill it, and it
// needs time to finish, so it fires with this much of the retention left.
export const IDLE_MARGIN_MS = 10 * 60 * 1000

export interface ContextSize extends CompactionHistory {
  readonly usedTokens: number
  /** The model's own window; zero or absent means nothing to measure against. */
  readonly contextWindow?: number
}

// The trigger a conversation's size calls for, or nothing. The edge is asked
// first and outranks everything, the floor included: a conversation there
// compacts whatever the setting says and however little it holds, because the
// alternative is a conversation that cannot be sent to at all. On a model
// whose whole window is smaller than the wide-window floor — π's catalog
// lists 8k, 16k and 32k models — a floor asked first would answer "too small"
// at the edge and every send after it would error.
//
// Both rules ask two things, not one: how big the conversation is, and how
// much of that a compaction could take away. A compaction is a whole-context
// model request and a broken prefix, so one that would hand back the window
// the conversation already has is the incremental trimming the research
// rejected — bought once a turn, forever, since the next turn crosses the same
// line again.
export function sizeTrigger(
  settings: CompactionSettings,
  size: ContextSize
): CompactionTrigger | undefined {
  const window = size.contextWindow ?? 0
  if (window > 0) {
    const edge = window - windowEdgeReserveTokens(window)
    // Once as a last resort means once. A conversation whose own compaction
    // landed at the edge is one compacting cannot move: it would write the
    // same account and the same skeleton and come back to the same edge, and
    // the turns it bought would each cost a full context. Where the last one
    // did get it clear, growing back to the edge is growth a compaction can
    // take away again.
    if (size.usedTokens >= edge) return (size.compactedTo ?? 0) < edge ? 'windowEdge' : undefined
  }
  if (size.usedTokens < smallestWorthCompacting(size.contextWindow, size.compactedTo)) {
    return undefined
  }
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

export interface IdleFacts extends CompactionHistory {
  /** Epoch ms of the conversation's last billed request. */
  readonly lastRequestAt: number
  readonly usedTokens: number
  /** The model's own window, when the reporter knows it. */
  readonly contextWindow?: number
  readonly retention: CacheRetention
}

// Whether the quiet has run long enough, with a warm cache and something
// worth compacting behind it.
//
// The switch gates this one. An idle compaction is a paid background request
// that rewrites what the agent reads, and the setting is the switch for the
// feature: the one thing ruled to survive it being off is the model's own
// window edge, which is the alternative to a conversation that errors on
// every send. Housekeeping the user switched off is not in that carve-out,
// and the Settings pane says so in as many words.
export function idleTrigger(
  settings: CompactionSettings,
  facts: IdleFacts,
  now: number
): 'idle' | undefined {
  if (!settings.enabled) return undefined
  const delay = idleCompactionDelayMs(facts.retention)
  if (delay === undefined) return undefined
  if (facts.usedTokens < smallestWorthCompacting(facts.contextWindow, facts.compactedTo)) {
    return undefined
  }
  const waited = now - facts.lastRequestAt
  // Past the retention the prefix is already gone, so the request this would
  // make would re-bill the conversation rather than read it.
  if (waited < delay || waited >= cacheTtlMs(facts.retention)) return undefined
  return 'idle'
}

// The smallest size at which `sizeTrigger` fires for this conversation, or
// nothing where no size would. Derived from the predicate rather than written
// beside it, so the two cannot disagree: the candidates are the only points
// at which the predicate's answer can change, and the first that fires is
// the answer.
export function compactionDue(
  settings: CompactionSettings,
  size: Omit<ContextSize, 'usedTokens'>
): number | undefined {
  const window = size.contextWindow ?? 0
  const candidates = [
    thresholdTokens(settings),
    smallestWorthCompacting(size.contextWindow, size.compactedTo),
    ...(window > 0 ? [window - windowEdgeReserveTokens(window)] : [])
  ].sort((left, right) => left - right)
  return candidates.find((used) => sizeTrigger(settings, { ...size, usedTokens: used }) !== undefined)
}

// π's own compaction settings, arranged so π's check inside a turn fires at
// exactly the size Crucible's rules fire at between turns. π checks between
// one tool round and the next — `tokens > contextWindow - reserveTokens` —
// and that is the one place a compaction can land while an agent works.
// A workflow node is one long turn: without this, a node grows to the
// model's window and errors there, because nothing between turns ever runs.
// The tail π keeps is zero; the hook ages out everything regardless.
export function piCompactionSettings(
  settings: CompactionSettings,
  size: Omit<ContextSize, 'usedTokens'>
): { readonly enabled: boolean; readonly reserveTokens?: number; readonly keepRecentTokens: 0 } {
  const window = size.contextWindow ?? 0
  const due = compactionDue(settings, size)
  // π cannot check a window it does not know, and a conversation no size
  // would compact is left to π's own overflow handling, which the same hook
  // also answers.
  if (window <= 0 || due === undefined) return { enabled: false, keepRecentTokens: 0 }
  // `>` in π against `>=` here: one token of reserve more.
  return { enabled: true, reserveTokens: Math.max(1, window - due + 1), keepRecentTokens: 0 }
}
