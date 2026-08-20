import type { QuotaError } from '../../../shared/quota/types'
import type { AdapterRequest, FetchLike } from './types'

// Nothing here logs: a failed request is a provider state, and the store
// reports state once per transition rather than once per attempt.

export type JsonResult =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly error: QuotaError }

export interface JsonRequest extends AdapterRequest {
  readonly url: string
  readonly bearer: string
  /** Provider-specific extras. Never identity. */
  readonly headers?: Record<string, string>
}

/** No exception escapes: every failure is one of the three quota errors. */
export async function getJson(req: JsonRequest): Promise<JsonResult> {
  const doFetch: FetchLike = req.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const remaining = req.deadline - Date.now()
  // Out of time before starting is the same "unavailable" a timeout produces.
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
    return { ok: false, error: 'unavailable' }
  }

  try {
    return { ok: true, payload: JSON.parse(body) }
  } catch {
    // Not JSON at all, which is the contract-drift signal `unparsed` carries.
    return { ok: false, error: 'unparsed' }
  }
}
