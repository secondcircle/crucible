import type { QuotaError } from '../../../shared/quota/types'
import type { AdapterRequest, FetchLike } from './types'

/**
 * The one authenticated GET every adapter makes, and the failure taxonomy:
 *
 *   401 / 403          → unauthorized  (the token is dead or wrong-scoped)
 *   any other non-2xx  → unavailable   (429 included — honored, never retried)
 *   transport / abort  → unavailable   (node `fetch` has NO default timeout, so
 *                                       the deadline's signal is the only thing
 *                                       that ends a hung request)
 *   body is not JSON   → unparsed      (the contract-drift signal)
 *
 * Nothing here knows a provider: URLs, extra headers and payload rules live in
 * the adapter that calls this.
 *
 * Nothing here logs either. A failed request is a provider *state*, and state
 * reporting belongs to the store — once per provider per transition, not once
 * per attempt and not once per distinct status code.
 */

export type JsonResult =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly error: QuotaError }

export interface JsonRequest extends AdapterRequest {
  readonly url: string
  readonly bearer: string
  /** Provider-specific extras (`originator: pi`). Never identity. */
  readonly headers?: Record<string, string>
}

/** GET a JSON document with a bearer, a deadline and no exceptions escaping. */
export async function getJson(req: JsonRequest): Promise<JsonResult> {
  const doFetch: FetchLike = req.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const remaining = req.deadline - Date.now()
  // The deadline has already passed: the caller's whole pass is out of time, so
  // this is the same "unavailable" any timeout produces.
  if (remaining <= 0) return { ok: false, error: 'unavailable' }

  let body: string
  try {
    const res = await doFetch(req.url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${req.bearer}`,
        accept: 'application/json',
        ...req.headers
      },
      signal: AbortSignal.timeout(remaining)
    })
    if (!res.ok) {
      return {
        ok: false,
        error: res.status === 401 || res.status === 403 ? 'unauthorized' : 'unavailable'
      }
    }
    body = await res.text()
  } catch {
    // Transport failure, or the deadline's signal firing mid-flight.
    return { ok: false, error: 'unavailable' }
  }

  try {
    return { ok: true, payload: JSON.parse(body) }
  } catch {
    // Not JSON at all: the contract-drift signal, which `unparsed` is.
    return { ok: false, error: 'unparsed' }
  }
}
