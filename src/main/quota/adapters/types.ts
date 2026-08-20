import type { QuotaError, QuotaMeter } from '../../../shared/quota/types'

// These contracts stay in main: the renderer knows the published record and
// never the wire formats behind it.

// Narrow on purpose: the global `fetch` satisfies it and so does a stand-in
// that never opens a socket.
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface AdapterRequest {
  /**
   * Epoch ms on the wall clock even where a clock is injected: it bounds a
   * socket, and the signal that cancels one measures real time.
   */
  readonly deadline: number
  readonly fetchImpl?: FetchLike
  /**
   * Dropped meters only, at most once per distinct message per process. Fetch
   * and parse states are the store's to report.
   */
  readonly log?: (message: string) => void
}

/** `ok` with no meters is a real state: reachable, nothing metered. */
export type AdapterResult =
  | { readonly ok: true; readonly meters: readonly QuotaMeter[] }
  | { readonly ok: false; readonly error: QuotaError }

/** Never throws for "no data": a caller classifies nothing. */
export interface ProviderAdapter {
  /** π's own provider id — the cache key and the snapshot key. */
  readonly providerId: string
  fetchQuota(bearer: string, req: AdapterRequest): Promise<AdapterResult>
}
