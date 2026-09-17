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
  // The size each conversation's own last compaction left it at. Compacting
  // takes the recent span as it finds it, so a conversation that is still over
  // the threshold afterwards gains nothing from a second pass: it would keep
  // the same span, report the same size and ask again, forever. Nothing fires
  // on size again until the conversation has grown past what its compaction
  // produced. `Infinity` is a compaction whose result has not been reported
  // yet, which nothing can be over.
  const compactedTo = new Map<string, number>()
  let disposed = false

  function disarm(held: Watched | undefined): void {
    if (held?.timer === undefined) return
    clearTimer(held.timer)
    held.timer = undefined
  }

  // Held facts are dropped at the moment a compaction is asked for: the
  // conversation this describes no longer exists, and nothing may fire again
  // until its new size is reported.
  function fire(id: string, trigger: CompactionTrigger): void {
    disarm(watched.get(id))
    watched.delete(id)
    compactedTo.set(id, Number.POSITIVE_INFINITY)
    options.compact(id, trigger)
  }

  function consider(id: string): void {
    if (disposed) return
    const held = watched.get(id)
    if (held === undefined || !options.idle(id)) return
    const grown = held.facts.usedTokens > (compactedTo.get(id) ?? -1)
    const trigger = grown ? sizeTrigger(options.settings(), held.facts) : undefined
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
      // The first size reported after a compaction is that compaction's own
      // work, and it is the size the next one has to beat.
      if (compactedTo.get(id) === Number.POSITIVE_INFINITY) {
        compactedTo.set(id, facts.usedTokens)
      }
      disarm(watched.get(id))
      watched.set(id, { facts })
      consider(id)
    },

    settled(id: string): void {
      consider(id)
    },

    forget(id: string): void {
      disarm(watched.get(id))
      watched.delete(id)
      compactedTo.delete(id)
    },

    dispose(): void {
      disposed = true
      for (const held of watched.values()) disarm(held)
      watched.clear()
      compactedTo.clear()
    }
  }
}
