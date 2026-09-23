import type { CacheRetention } from '../agent/port'
import type { CompactionTrigger } from './record.ts'
import type { CompactionSettings } from './settings.ts'
import { idleCompactionDelayMs, idleTrigger, sizeTrigger } from './trigger.ts'

// Who compacts and when, for one collection of conversations. The rules are
// the pure predicates beside this; what this adds is the timer that fires when
// a conversation has sat long enough. Sessions and workflow nodes both drive
// one of these, so there is no second set of rules anywhere.
//
// Nothing about a conversation is remembered here across a report, and
// nothing about one outlives the launch: every fact the rules decide on
// arrives with the reported size, from whoever is holding the conversation.

// What a conversation's last billed request said about it. Three independent
// facts, and only the size is always there: the size rules need nothing but
// the size and what the last compaction produced, while the idle rule is a
// rule about the cache and cannot run without an instant to count the quiet
// from.
export interface ConversationFacts {
  readonly usedTokens: number
  /** The model's own window, when the reporter knows it. */
  readonly contextWindow?: number
  // Epoch ms of the request whose prefix the provider is holding. Absent
  // wherever there is no such prefix to lose — a provider that does not cache,
  // a conversation that has not billed since its last compaction — which
  // silences the idle rule for it and nothing else.
  readonly lastRequestAt?: number
  // What this conversation's own last compaction left it at, and nothing
  // where it has never compacted. Every rule here weighs it: the size says how
  // big the conversation is, this says how much of that another compaction
  // could take away. It is reported rather than remembered because it is
  // written down with the conversation — a launch that never saw the
  // compaction reads the same number the launch that ran it did, and a
  // conversation restored onto a path with no compaction behind it reports
  // none.
  readonly compactedTo?: number
}

export interface CompactionWatch {
  // Fresh facts: the conversation billed a request. Re-arms its idle timer and
  // compacts at once if its size now calls for it.
  saw(id: string, facts: ConversationFacts): void
  // The compaction this watch asked for is over, however it ended — landed,
  // no boundary to cut at, a model call that failed, a summary that came back
  // empty, a cancelled wait. Every compaction the watch asks for comes back
  // here, because until it does nothing fires for that conversation at all.
  // What it left the conversation at is not said here: that is the
  // conversation's own fact, and it arrives with the next size reported for
  // it.
  compacted(id: string): void
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
  // The conversations whose compaction is out. Nothing fires for one while it
  // is in here: the conversation the held facts describe is being rewritten,
  // and what that is worth is not known until `compacted` says.
  const asked = new Set<string>()
  let disposed = false

  // The facts as the rules must read them. A compaction still out has produced
  // nothing yet, and nothing is smaller than a size nobody knows, so a
  // conversation being rewritten is held out of every rule until it reports
  // again.
  function weigh(id: string, facts: ConversationFacts): ConversationFacts {
    return asked.has(id) ? { ...facts, compactedTo: Number.POSITIVE_INFINITY } : facts
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
    const trigger = sizeTrigger(options.settings(), weigh(id, held.facts))
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
      const facts = weigh(id, held.facts)
      const due = idleTrigger(
        options.settings(),
        {
          lastRequestAt,
          usedTokens: facts.usedTokens,
          ...(facts.contextWindow === undefined ? {} : { contextWindow: facts.contextWindow }),
          ...(facts.compactedTo === undefined ? {} : { compactedTo: facts.compactedTo }),
          retention: options.retention
        },
        now()
      )
      if (due !== undefined) {
        fire(id, due)
        return
      }
      // Struck ahead of the deadline. The timer runs on the process's
      // monotonic clock and the deadline sits on the wall clock the prefix was
      // stamped with; over fifty minutes the two drift apart by milliseconds,
      // and Node's timers strike a millisecond early on their own besides. The
      // rule answered "not yet", not "no", so the wait resumes for what is
      // left. Dropped here instead, the conversation sat unwatched until its
      // next turn re-billed the whole thing, the one bill this clock exists to
      // prevent.
      if (now() < at) arm(id, held)
    }, Math.max(0, at - now()))
  }

  return {
    saw(id: string, facts: ConversationFacts): void {
      if (disposed) return
      disarm(watched.get(id))
      watched.set(id, { facts })
      consider(id)
    },

    // What the compaction did is the conversation's to report: one that landed
    // says so with its next size, and one that rewrote nothing leaves the
    // conversation exactly as the rules last judged it. Either way the rules
    // speak again on the next report rather than now, so a compaction that
    // keeps failing is retried at the pace of the conversation rather than in
    // a loop.
    //
    // Facts that arrived while the compaction was out go with it. They
    // describe the conversation as it stood before the rewrite — the turn that
    // crossed the threshold reports its size once more as it ends, after the
    // ask has gone out — and π reports no size at all for the rewritten one
    // until it has answered a request, so nothing replaces them before the
    // next turn settles. Left in place, that settle judged a 200k conversation
    // that no longer existed and compacted a 68k one on its heels.
    compacted(id: string): void {
      asked.delete(id)
      disarm(watched.get(id))
      watched.delete(id)
    },

    settled(id: string): void {
      consider(id)
    },

    forget(id: string): void {
      disarm(watched.get(id))
      watched.delete(id)
      asked.delete(id)
    },

    dispose(): void {
      disposed = true
      for (const held of watched.values()) disarm(held)
      watched.clear()
      asked.clear()
    }
  }
}
