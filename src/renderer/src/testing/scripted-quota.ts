import type { QuotaListener, QuotaService, Unsubscribe } from '../../../shared/quota/service'
import type { QuotaSnapshot } from '../../../shared/quota/types'

// Answers the way main does but fetches nothing and announces nothing by
// itself, so a component test is about what the strip draws and what it asks
// for, never about timing a real refresh.

export interface ScriptedQuota extends QuotaService {
  /** Every call the strip made, oldest first. */
  readonly calls: ReadonlyArray<{
    readonly op: 'read' | 'refresh'
    readonly providers?: readonly string[]
  }>
  /** What `read` and `refresh` answer with. A test may change it between calls. */
  snapshot: QuotaSnapshot
  /** Set where a test wants the refusal a rejected IPC call is. */
  refusal?: string
  // Hold every refresh's answer, so a test can see what the strip paints while
  // the first one is still running.
  holdRefresh?: boolean
  /** Answers every held refresh. */
  releaseRefresh(): void
  /** A refresh result the way main broadcasts one to every window. */
  announce(snapshot: QuotaSnapshot): void
}

/** The refreshes a test asked about, scope and all. */
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
