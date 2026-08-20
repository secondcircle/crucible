import type { QuotaListener, QuotaService, Unsubscribe } from './service'
import type { QuotaSnapshot } from './types'

// No network, no credential read, no disk, so an agent-driven check never
// touches the human's quota or the cache the machine's apps share. The numbers
// are picked to put every visual state on screen at once.

const HOUR = 60 * 60 * 1000

// Anchored to launch, so nothing has lapsed by the time it paints.

export function cannedQuotaSnapshot(launchedAt: number): QuotaSnapshot {
  const at = (hours: number): number => launchedAt + hours * HOUR

  return {
    fetchedAt: launchedAt,
    providers: {
      // 61 h into the week: both weekly fills sit behind the pace tick.
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
      // 92 h in at 78%: the projection lands past 100% before the reset, which
      // is what earns the out-word.
      'openai-codex': {
        providerId: 'openai-codex',
        fetchedAt: launchedAt,
        meters: [
          { kind: 'session', label: '5H', usedPercent: 91, resetsAt: at(1.4) },
          { kind: 'weekly', label: '7D', usedPercent: 78, resetsAt: at(76) }
        ]
      },
      // 46 h in at 19%: behind its tick.
      xai: {
        providerId: 'xai',
        fetchedAt: launchedAt,
        meters: [{ kind: 'weekly', label: '7D', usedPercent: 19, resetsAt: at(122) }]
      }
    }
  }
}

// One snapshot for the launch, so a check is deterministic: nothing behind
// this service can change, and `onChange` never has anything new to say.
export function createFakeQuotaService(launchedAt: number = Date.now()): QuotaService {
  const snapshot = cannedQuotaSnapshot(launchedAt)
  const listeners = new Set<QuotaListener>()

  return {
    read: () => Promise.resolve(snapshot),
    // A scope changes nothing: there is nothing here to fetch.
    refresh: () => Promise.resolve(snapshot),
    onChange(listener: QuotaListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
