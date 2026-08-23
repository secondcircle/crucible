// Carries no identity — no token, account id or email — so the same bytes are
// safe on disk, over IPC and in the DOM. Imports nothing, so nothing
// SDK-shaped can ride across on a type.

export interface QuotaMeter {
  readonly kind: 'session' | 'weekly' | 'weekly_scoped' | 'monthly'
  /** Provider-reported, uppercase, short: "5H", "7D", "FABLE". */
  readonly label: string
  /** Used, 0–100. Never remaining, never a 0–1 fraction. */
  readonly usedPercent: number
  /** Epoch ms UTC; null = the provider reported no reset instant. */
  readonly resetsAt: number | null
  readonly scopeName?: string
  readonly isActive?: boolean
  // A dollar budget, in major currency units, present exactly when kind is
  // 'monthly'. Budget numbers, not identity: what a plan costs says nothing
  // about who holds it.
  readonly usedDollars?: number
  readonly limitDollars?: number
}

// Narrower than an exception on purpose: only states the strip can draw.
export type QuotaError = 'unauthorized' | 'unavailable' | 'unparsed'

export interface ProviderQuota {
  /** π's own provider ids: "anthropic", "openai-codex", "xai". */
  readonly providerId: string
  /** May be empty: reachable, nothing metered. */
  readonly meters: readonly QuotaMeter[]
  /** Epoch ms; how old the data is, not when it was last attempted. */
  readonly fetchedAt: number
  /** Set only when the last attempt failed; meters keep the last good read. */
  readonly error?: QuotaError
}

export interface QuotaSnapshot {
  /** Absent key = no adapter, no credential, or not a subscription. */
  readonly providers: Readonly<Record<string, ProviderQuota>>
  readonly fetchedAt: number
}

export function emptyQuotaSnapshot(fetchedAt: number): QuotaSnapshot {
  return { providers: {}, fetchedAt }
}
