import type { QuotaSnapshot } from './types'

// Beside the agent port, not behind it: quota is global, session-free provider
// data, and main-side code with no port still has to read it.

export type Unsubscribe = () => void

export type QuotaListener = (snapshot: QuotaSnapshot) => void

export interface QuotaRefreshOptions {
  /** Refresh only these providers; everything else is left alone. */
  readonly providers?: readonly string[]
}

export interface QuotaService {
  /** Never triggers a fetch. */
  read(): Promise<QuotaSnapshot>
  /** Never rejects for a fetch failure: trouble reaches the user as staleness. */
  refresh(opts?: QuotaRefreshOptions): Promise<QuotaSnapshot>
  onChange(listener: QuotaListener): Unsubscribe
}
