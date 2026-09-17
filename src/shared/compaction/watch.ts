import type { CacheRetention } from '../agent/port'
import type { CompactionTrigger } from './record.ts'
import type { CompactionSettings } from './settings.ts'
import { idleCompactionDelayMs, idleTrigger, sizeTrigger } from './trigger.ts'

// Who compacts and when, for one collection of conversations. The rules are
// the pure predicates beside this; what this adds is the memory of each
// conversation's last billed request and the timer that fires when it has sat
// long enough. Sessions and workflow nodes both drive one of these, so there
// is no second set of rules anywhere.

// What a conversation's last billed request said about it. Two independent
// facts, and only the size is always there: the size rules need nothing but
// the size, while the idle rule is a rule about the cache and cannot run
// without an instant to count the quiet from.
export interface ConversationFacts {
  readonly usedTokens: number
  /** The model's own window, when the reporter knows it. */
  readonly contextWindow?: number
  // Epoch ms of the request whose prefix the provider is holding. Absent
  // wherever there is no such prefix to lose — a provider that does not cache,
  // a conversation that has not billed since its last compaction — which
  // silences the idle rule for it and nothing else.
  readonly lastRequestAt?: number
}

export interface CompactionWatch {
  // Fresh facts: the conversation billed a request. Re-arms its idle timer and
  // compacts at once if its size now calls for it.
  saw(id: string, facts: ConversationFacts): void
  // The compaction this watch asked for is over: `tokensAfter` is the window it
  // left the conversation at, and nothing where it did not land — no boundary
  // to cut at, a model call that failed, a summary that came back empty, a
  // cancelled wait. Every compaction the watch asks for comes back here, both
  // ways: the size a compaction produces is what the next one has to beat, and
  // until this is called nothing fires for that conversation at all.
  compacted(id: string, tokensAfter?: number): void
  /** The conversation stopped working, which is when a held trigger can act. */
  settled(id: string): void
  /** The conversation is gone: no timer outlives it. */
  forget(id: string): void
  dispose(): void
}

export interface CompactionWatchOptions {
  /** Read per decision, because the setting can change between them. */
  readonly settings: () => CompactionSettings
  readonly retention: CacheRetention
  // Whether this conversation can be rewritten right now. A compaction takes
  // the conversation away from whatever is using it, so nothing runs one over
  // a live turn: the trigger waits for `settled` instead.
  readonly idle: (id: string) => boolean
  /** Never rejects into here: the caller narrates its own failures. */
  readonly compact: (id: string, trigger: CompactionTrigger) => void
  readonly now?: () => number
  readonly setTimer?: (run: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

interface Watched {
  readonly facts: ConversationFacts
  timer?: unknown
}

export function createCompactionWatch(options: CompactionWatchOptions): CompactionWatch {
  const now = options.now ?? ((): number => Date.now())
  const setTimer =
    options.setTimer ?? ((run: () => void, ms: number): unknown => setTimeout(run, ms))
  const clearTimer =
    options.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as never))
  const watched = new Map<string, Watched>()
  // The size each conversation's own last compaction left it at, which is the
  // second fact every rule here decides on: what the rules ask is not "is this
  // conversation big" but "is there enough here for a compaction to take
  // away", and this is what the last one could not. It is measured rather than
  // estimated, so a conversation whose words alone exceed the budgets is
  // judged by what compacting it actually does.
  const compactedTo = new Map<string, number>()
  // The conversations whose compaction is out. Nothing fires for one while it
  // is in here: the conversation the held facts describe is being rewritten,
  // and what that is worth is not known until `compacted` says.
  const asked = new Set<string>()
  let disposed = false

  /** What this conversation's last compaction produced, for the rules to weigh. */
  function lastResult(id: string): { compactedTo?: number } {
    // A compaction still out has produced nothing yet, and nothing is smaller
    // than a size nobody knows.
    if (asked.has(id)) return { compactedTo: Number.POSITIVE_INFINITY }
    const left = compactedTo.get(id)
    return left === undefined ? {} : { compactedTo: left }
  }

  function disarm(held: Watched | undefined): void {
    if (held?.timer === undefined) return
    clearTimer(held.timer)
    held.timer = undefined
  }

  // Held facts are dropped at the moment a compaction is asked for: the
  // conversation this describes no longer exists. Nothing fires again until
  // that compaction has reported what it did and a new size has been seen.
  function fire(id: string, trigger: CompactionTrigger): void {
    disarm(watched.get(id))
    watched.delete(id)
    asked.add(id)
    options.compact(id, trigger)
  }

  function consider(id: string): void {
    if (disposed) return
    const held = watched.get(id)
    if (held === undefined || !options.idle(id)) return
    const trigger = sizeTrigger(options.settings(), {
      ...held.facts,
      ...lastResult(id)
    })
    if (trigger !== undefined) {
      fire(id, trigger)
      return
    }
    arm(id, held)
  }

  // One timer per conversation, re-armed from the last request rather than
  // from now, so the deadline is the cache's and not the timer's. No reported
  // prefix instant means no warm cache to run ahead of, so no timer.
  //
  // The setting is read when the timer fires rather than when it is armed: a
  // switch turned off while a conversation sat idle governs that conversation
  // too.
  function arm(id: string, held: Watched): void {
    disarm(held)
    const lastRequestAt = held.facts.lastRequestAt
    if (lastRequestAt === undefined) return
    const delay = idleCompactionDelayMs(options.retention)
    if (delay === undefined) return
    const at = lastRequestAt + delay
    held.timer = setTimer(() => {
      held.timer = undefined
      if (disposed || !options.idle(id)) return
      const due = idleTrigger(
        options.settings(),
        {
          lastRequestAt,
          usedTokens: held.facts.usedTokens,
          ...(held.facts.contextWindow === undefined
            ? {}
            : { contextWindow: held.facts.contextWindow }),
          ...lastResult(id),
          retention: options.retention
        },
        now()
      )
      if (due !== undefined) fire(id, due)
    }, Math.max(0, at - now()))
  }

  return {
    saw(id: string, facts: ConversationFacts): void {
      if (disposed) return
      disarm(watched.get(id))
      watched.set(id, { facts })
      consider(id)
    },

    // A compaction that landed is the size the next one has to beat. One that
    // did not land rewrote nothing, so the conversation is what it was and the
    // rules judge it as they did before — on the next report, not now, so a
    // compaction that keeps failing is retried at the pace of the conversation
    // rather than in a loop.
    compacted(id: string, tokensAfter?: number): void {
      if (!asked.delete(id)) return
      if (tokensAfter !== undefined) compactedTo.set(id, tokensAfter)
    },

    settled(id: string): void {
      consider(id)
    },

    forget(id: string): void {
      disarm(watched.get(id))
      watched.delete(id)
      compactedTo.delete(id)
      asked.delete(id)
    },

    dispose(): void {
      disposed = true
      for (const held of watched.values()) disarm(held)
      watched.clear()
      compactedTo.clear()
      asked.clear()
    }
  }
}
