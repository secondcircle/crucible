// Preload and main have to agree letter for letter here, like every other
// channel pair.

import type { ScheduleEvent } from './service'

export const SCHEDULE_REQUEST_CHANNEL = 'crucible:schedules:request'

export const SCHEDULE_EVENT_CHANNEL = 'crucible:schedules:event'

// The name is the service method's own, so there is no second vocabulary.
export interface ScheduleRequest {
  readonly op: string
  readonly args: readonly unknown[]
}

// A value rather than a throw, because Electron rewraps a handler's throw and
// hides the sentence written for a person.
export type ScheduleResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string }

export type { ScheduleEvent }
