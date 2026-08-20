import type { QuotaListener, QuotaService, Unsubscribe } from './service'
import type { QuotaSnapshot } from './types'

// The canned quota service: no network, no credential read, no disk. It is
// what the fake launch flavor serves, so an agent-driven check never touches
// the human's quota or the cache the machine's apps share.
//
// The numbers are chosen so the arithmetic is coherent and every visual state
// stands on screen at once: an amber meter, a red one with its `!`, a provider
// whose weekly burn projects past 100% (the out-word), and two that are
// comfortably behind their pace ticks.

const HOUR = 60 * 60 * 1000

/** Everything is anchored to launch, so nothing has lapsed by the time it paints. */
export function cannedQuotaSnapshot(launchedAt: number): QuotaSnapshot {
  const at = (hours: number): number => launchedAt + hours * HOUR

  return {
    fetchedAt: launchedAt,
    providers: {
      // 61 h into its week: the tick sits near 36% and both weekly fills are
      // behind it, so Anthropic says nothing beyond its numbers.
      anthropic: {
        providerId: 'anthropic',
        fetchedAt: launchedAt,
        meters: [
          { kind: 'session', label: '5H', usedPercent: 73, resetsAt: at(2.8) },
          { kind: 'weekly', label: '7D', usedPercent: 29, resetsAt: at(107) },
          {
            kind: 'weekly_scoped',
            label: 'FABLE',
            usedPercent: 22,
            resetsAt: at(107),
            scopeName: 'Fable',
            isActive: true
          }
        ]
      },
      // 92 h in with 78% spent: the projection lands past 100% before the
      // reset, which is the whole of what the out-word says.
      'openai-codex': {
        providerId: 'openai-codex',
        fetchedAt: launchedAt,
        meters: [
          { kind: 'session', label: '5H', usedPercent: 91, resetsAt: at(1.4) },
          { kind: 'weekly', label: '7D', usedPercent: 78, resetsAt: at(76) }
        ]
      },
      // 46 h in at 19%: behind its tick, and the only meter this plan reports.
      xai: {
        providerId: 'xai',
        fetchedAt: launchedAt,
        meters: [{ kind: 'weekly', label: '7D', usedPercent: 19, resetsAt: at(122) }]
      }
    }
  }
}

/**
 * One snapshot for the launch. `read` and `refresh` answer with the same
 * object, and `onChange` never has anything new to say: nothing behind this
 * service can change, which is what makes a check deterministic.
 */
export function createFakeQuotaService(launchedAt: number = Date.now()): QuotaService {
  const snapshot = cannedQuotaSnapshot(launchedAt)
  const listeners = new Set<QuotaListener>()

  return {
    read: () => Promise.resolve(snapshot),
    // A scope changes nothing: there is nothing to fetch, so a scoped ask and
    // a whole one are the same silence.
    refresh: () => Promise.resolve(snapshot),
    onChange(listener: QuotaListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
