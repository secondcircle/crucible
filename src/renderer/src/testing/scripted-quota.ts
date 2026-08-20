import type { QuotaListener, QuotaService, Unsubscribe } from '../../../shared/quota/service'
import type { QuotaSnapshot } from '../../../shared/quota/types'

// Answers the way main does but fetches nothing and announces nothing by
// itself, so a component test never times a real refresh.

export interface ScriptedQuota extends QuotaService {
  /** Every call the strip made, oldest first. */
  readonly calls: ReadonlyArray<{
    readonly op: 'read' | 'refresh'
    readonly providers?: readonly string[]
  }>
  /** May be changed between calls. */
  snapshot: QuotaSnapshot
  /** The refusal a rejected IPC call is. */
  refusal?: string
  // Holding a refresh is how a test sees what the strip paints while one is
  // still running.
  holdRefresh?: boolean
  releaseRefresh(): void
  announce(snapshot: QuotaSnapshot): void
}

export function refreshes(
  quota: ScriptedQuota
): ReadonlyArray<{ readonly op: 'read' | 'refresh'; readonly providers?: readonly string[] }> {
  return quota.calls.filter((call) => call.op === 'refresh')
}

export function createScriptedQuota(snapshot: QuotaSnapshot): ScriptedQuota {
  const listeners = new Set<QuotaListener>()
  const calls: Array<{ op: 'read' | 'refresh'; providers?: readonly string[] }> = []
  let held: Array<() => void> = []

  const service: ScriptedQuota = {
    calls,
    snapshot,

    read(): Promise<QuotaSnapshot> {
      calls.push({ op: 'read' })
      if (service.refusal !== undefined) return Promise.reject(new Error(service.refusal))
      return Promise.resolve(service.snapshot)
    },

    refresh(opts = {}): Promise<QuotaSnapshot> {
      calls.push(
        opts.providers === undefined ? { op: 'refresh' } : { op: 'refresh', providers: opts.providers }
      )
      if (service.refusal !== undefined) return Promise.reject(new Error(service.refusal))
      if (service.holdRefresh !== true) return Promise.resolve(service.snapshot)
      return new Promise<QuotaSnapshot>((resolve) => {
        held.push(() => resolve(service.snapshot))
      })
    },

    onChange(listener: QuotaListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    releaseRefresh(): void {
      const waiting = held
      held = []
      for (const answer of waiting) answer()
    },

    announce(taken: QuotaSnapshot): void {
      service.snapshot = taken
      for (const listener of [...listeners]) listener(taken)
    }
  }

  return service
}
