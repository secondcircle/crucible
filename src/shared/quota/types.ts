// The normalized quota record: what one provider subscription says about how
// much of itself this machine has spent.
//
// It carries no identity — no token, account id or email — so the same bytes
// are safe on disk, over IPC and in the DOM. This module imports nothing, like
// the port does not, so nothing SDK-shaped can ride across on a type.
//
// The feature is named quota everywhere in code and in the UI. The Settings
// sheet's Usage tab already means session tokens and cost; the only place the
// old word survives is the on-disk cache path, which is an interop contract
// with the legacy system rather than Crucible code.

/** One window of one plan. Percent is USED, 0–100, never remaining. */
export interface QuotaMeter {
  readonly kind: 'session' | 'weekly' | 'weekly_scoped'
  /** Provider-reported, uppercase, short: "5H", "7D", "FABLE". */
  readonly label: string
  /** Used, 0–100. Never remaining. Never a 0–1 fraction. */
  readonly usedPercent: number
  /** Epoch ms UTC; null = the provider reported no reset instant. */
  readonly resetsAt: number | null
  /** The provider's own name for a scoped meter, e.g. "Fable". */
  readonly scopeName?: string
  /** The provider says this meter is currently the binding one. */
  readonly isActive?: boolean
}

/** Why the last attempt produced nothing. Narrower than an exception on purpose. */
export type QuotaError = 'unauthorized' | 'unavailable' | 'unparsed'

export interface ProviderQuota {
  /** π's own provider ids: "anthropic", "openai-codex", "xai". */
  readonly providerId: string
  /** May be empty: reachable, nothing metered. */
  readonly meters: readonly QuotaMeter[]
  /** Epoch ms; how old the data is, not when it was last attempted. */
  readonly fetchedAt: number
  /** Present only when the last attempt failed; meters hold the last good read. */
  readonly error?: QuotaError
}

/** Absent key = no adapter, no credential, or not a subscription. */
export interface QuotaSnapshot {
  readonly providers: Readonly<Record<string, ProviderQuota>>
  readonly fetchedAt: number
}

/** The empty answer: a machine where nothing has ever been fetched. */
export function emptyQuotaSnapshot(fetchedAt: number): QuotaSnapshot {
  return { providers: {}, fetchedAt }
}
