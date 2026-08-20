import type { QuotaSnapshot } from './types'

// Quota rides its own Crucible-owned service beside the agent port: the strip
// is global, session-free provider data, and the read seam has to be reachable
// by main-side code that has no port. The renderer never imports the plumbing
// behind this interface — it takes the service as a prop, exactly as it takes
// the workspace and update seams.

export type Unsubscribe = () => void

export type QuotaListener = (snapshot: QuotaSnapshot) => void

export interface QuotaRefreshOptions {
  /** Refresh only these providers; everything else is left alone. */
  readonly providers?: readonly string[]
}

export interface QuotaService {
  /** The cache, right now. Never triggers a fetch. */
  read(): Promise<QuotaSnapshot>
  /**
   * TTL-gated refresh, scoped when `providers` is given. Never rejects for a
   * fetch failure: trouble reaches the user as staleness in the data.
   */
  refresh(opts?: QuotaRefreshOptions): Promise<QuotaSnapshot>
  /** Fired with the resulting snapshot after every completed refresh pass. */
  onChange(listener: QuotaListener): Unsubscribe
}
