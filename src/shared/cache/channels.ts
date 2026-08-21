// Preload and main have to agree letter for letter here, and a mismatch is
// silent until an operation goes unanswered in a running app.

export const CACHE_REQUEST_CHANNEL = 'crucible:cache:request'

export const CACHE_EVENT_CHANNEL = 'crucible:cache:event'

// The name is the service method's own, so there is no second vocabulary and
// no mapping table to keep in step.
export interface CacheRequest {
  readonly op: string
  readonly args: readonly unknown[]
}

// A value rather than a throw, because Electron rewraps a handler's throw into
// "Error invoking remote method …", hiding the sentence written for a person.
export type CacheResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string }
