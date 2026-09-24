// Preload and main have to agree letter for letter here, like every other
// channel pair.

import type { RulesEvent } from './service'

export const RULES_REQUEST_CHANNEL = 'crucible:rules:request'

export const RULES_EVENT_CHANNEL = 'crucible:rules:event'

// The name is the service method's own, so there is no second vocabulary.
export interface RulesRequest {
  readonly op: string
  readonly args: readonly unknown[]
}

// A value rather than a throw, because Electron rewraps a handler's throw and
// hides the sentence written for a person.
export type RulesResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string }

export type { RulesEvent }
