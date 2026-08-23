import { join } from 'node:path'

// The cache is Crucible's alone, under Crucible's own state directory, and so
// it follows the dev/installed split like everything else there. Crucible
// reads and writes nothing under `.pi`: π's directory is π's, and sharing a
// file format with another app would be a contract nobody agreed to.
// Credentials still come through the π SDK's API, which is π asking
// its own files on our behalf, not us reading them.

/** A mismatch discards the file rather than parsing it. */
export const CACHE_SCHEMA_VERSION = 1

// Beside the file layout because the reader filters by it, so a provider with
// no adapter is absent from the first cache-only snapshot rather than only
// after a store has run and pruned.
export const KNOWN_PROVIDER_IDS: readonly string[] = ['anthropic', 'openai-codex', 'xai']

// Provider ids become file names, so they may not become paths.
const SAFE_PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/i

export function isSafeProviderId(providerId: string): boolean {
  return SAFE_PROVIDER_ID.test(providerId) && !providerId.includes('..')
}

// Set once at startup from Electron's userData, so this module stays free of
// both Electron and π and the read half remains importable on its own.
let configured: string | undefined

/** Called by main before any store or reader is built. */
export function useQuotaCacheDir(dir: string): void {
  configured = dir
}

/** `dir` is the cache directory itself, which is how a test stays off the real one. */
export function quotaCacheDir(dir?: string): string {
  if (dir !== undefined) return dir
  if (configured === undefined) {
    // Nobody has said where Crucible's state lives, so there is no honest
    // answer. Guessing a path is how an app ends up writing somebody else's
    // directory.
    throw new Error('quota cache directory was never set: call useQuotaCacheDir first')
  }
  return join(configured, 'quota')
}

export function cacheFile(providerId: string, dir?: string): string {
  if (!isSafeProviderId(providerId)) throw new Error(`unsafe provider id: ${providerId}`)
  return join(quotaCacheDir(dir), `${providerId}.json`)
}

/** Per provider, so one provider's outage cannot deny the others. */
export function lockFile(providerId: string, dir?: string): string {
  return `${cacheFile(providerId, dir)}.lock`
}
