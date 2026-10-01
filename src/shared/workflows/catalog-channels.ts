// Preload and main have to agree letter for letter here, like every other
// channel pair.

import type { CatalogEvent } from './catalog'

export const CATALOG_REQUEST_CHANNEL = 'crucible:catalog:request'

export const CATALOG_EVENT_CHANNEL = 'crucible:catalog:event'

// The name is the service method's own, so there is no second vocabulary.
export interface CatalogRequest {
  readonly op: string
  readonly args: readonly unknown[]
}

// A value rather than a throw, because Electron rewraps a handler's throw and
// hides the sentence written for a person.
export type CatalogResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string }

export type { CatalogEvent }
