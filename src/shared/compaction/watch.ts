import type { CacheRetention } from '../agent/port'
import type { CompactionTrigger } from './record.ts'
import type { CompactionSettings } from './settings.ts'
import { idleCompactionDelayMs, idleTrigger, sizeTrigger } from './trigger.ts'

// Who compacts and when, for one collection of conversations. The rules are
// the pure predicates beside this; what this adds is the memory of each
// conversation's last billed request and the timer that fires when it has sat
// long enough. Sessions and workflow nodes both drive one of these, so there
// is no second set of rules anywhere.

/** What a conversation's last billed request said about it. */
export interface ConversationFacts {
  /** Epoch ms of that request. */
  readonly lastRequestAt: number
  readonly usedTokens: number
  /** The model's own window, when the reporter knows it. */
  readonly contextWindow?: number
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
    options.compact(id, trigger)
  }

  function consider(id: string): void {
    if (disposed) return
    const held = watched.get(id)
    if (held === undefined || !options.idle(id)) return
    const trigger = sizeTrigger(options.settings(), held.facts)
    if (trigger !== undefined) {
      fire(id, trigger)
      return
    }
    arm(id, held)
  }

  // One timer per conversation, re-armed from the last request rather than
  // from now, so the deadline is the cache's and not the timer's.
  function arm(id: string, held: Watched): void {
    disarm(held)
    const delay = idleCompactionDelayMs(options.retention)
    if (delay === undefined) return
    const at = held.facts.lastRequestAt + delay
    held.timer = setTimer(() => {
      held.timer = undefined
      if (disposed || !options.idle(id)) return
      const due = idleTrigger(
        {
          lastRequestAt: held.facts.lastRequestAt,
          usedTokens: held.facts.usedTokens,
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

    settled(id: string): void {
      consider(id)
    },

    forget(id: string): void {
      disarm(watched.get(id))
      watched.delete(id)
    },

    dispose(): void {
      disposed = true
      for (const held of watched.values()) disarm(held)
      watched.clear()
    }
  }
}
