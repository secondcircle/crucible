import { anthropicAdapter } from './anthropic'
import { codexAdapter } from './codex'
import type { ProviderAdapter } from './types'
import { xaiAdapter } from './xai'

// A provider with no adapter here is absent from the snapshot rather than zero:
// the strip renders what is there and never a fabricated number.
export const ADAPTERS: readonly ProviderAdapter[] = [anthropicAdapter, codexAdapter, xaiAdapter]
