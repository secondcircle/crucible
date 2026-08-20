import { anthropicAdapter } from './anthropic'
import { codexAdapter } from './codex'
import type { ProviderAdapter } from './types'
import { xaiAdapter } from './xai'

/**
 * The registered, verified adapters — the store's default set.
 *
 * A provider is here only once its endpoint has been called live with π's own
 * bearer and its payload captured. A provider with no adapter is simply absent
 * from the snapshot: the strip renders what is there, and nothing renders a
 * fake zero.
 */
export const ADAPTERS: readonly ProviderAdapter[] = [anthropicAdapter, codexAdapter, xaiAdapter]
