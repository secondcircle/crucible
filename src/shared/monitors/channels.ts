// Preload and main have to agree letter for letter here, like every other
// channel pair.

import type { MonitorEvent } from './service'

export const MONITOR_REQUEST_CHANNEL = 'crucible:monitors:request'

export const MONITOR_EVENT_CHANNEL = 'crucible:monitors:event'

/** The name is the service method's own, so there is no second vocabulary. */
export interface MonitorRequestMessage {
  readonly op: string
  readonly args: readonly unknown[]
}

// A value rather than a throw, because Electron rewraps a handler's throw and
// hides the sentence written for a person.
export type MonitorResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string }

export type { MonitorEvent }
