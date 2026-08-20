import type { QuotaError, QuotaMeter } from '../../../shared/quota/types'

// What a provider adapter is, and nothing about any particular provider. These
// contracts stay in main: the renderer knows the published record and never the
// wire formats behind it.

/**
 * The structural slice of `fetch` every adapter uses. Narrow on purpose: it is
 * what lets the tests drive an adapter with captured payloads and never touch
 * the network, and the global `fetch` satisfies it.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/** What a caller hands an adapter: a deadline, a transport, a diagnostics sink. */
export interface AdapterRequest {
  /**
   * The absolute epoch-ms instant the request must be given up on, on the wall
   * clock — it bounds a socket, and the signal that cancels one measures real
   * time. A store with an injected clock still builds this from `Date.now()`.
   */
  readonly deadline: number
  /** Injected transport; defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike
  /**
   * Diagnostics sink for dropped meters. Whatever the sink, each distinct
   * message is delivered at most once per process. Fetch and parse *states* are
   * not reported here; the store owns those.
   */
  readonly log?: (message: string) => void
}

/**
 * An adapter's answer. `ok` with an empty array is a real state — reachable,
 * nothing metered — and is not an error; the three error kinds are exactly the
 * ones `ProviderQuota.error` carries, so nothing above an adapter has to
 * classify an exception.
 */
export type AdapterResult =
  | { readonly ok: true; readonly meters: readonly QuotaMeter[] }
  | { readonly ok: false; readonly error: QuotaError }

/**
 * One provider's wire format, and nothing else. Given a bearer and a deadline,
 * return the meters this account currently has, or why not; never throw for "no
 * data". A caller need not know the URL, the query parameters, the account
 * header, the unit of the reset field, or which slot held which meter.
 */
export interface ProviderAdapter {
  /** π's own provider id — the cache key and the snapshot key. */
  readonly providerId: string
  fetchQuota(bearer: string, req: AdapterRequest): Promise<AdapterResult>
}
