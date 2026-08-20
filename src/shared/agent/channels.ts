// Preload and main have to agree letter for letter, and a mismatch is silent
// until an operation goes unanswered in a running app.

export const REQUEST_CHANNEL = 'crucible:request'

export const EVENT_CHANNEL = 'crucible:event'

// The name is the port method's own, so there is no second vocabulary and no
// mapping table to keep in step.
export interface PortRequest {
  readonly op: string
  readonly args: readonly unknown[]
}

// A value rather than a throw, because Electron rewraps a handler's throw into
// "Error invoking remote method …", hiding the sentence written for a person.
export type PortResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string }
