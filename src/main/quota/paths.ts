import { homedir } from 'node:os'
import { join } from 'node:path'

// The layout under the agent dir is an interop contract rather than Crucible's
// own: other apps on this machine read and write these same files under the
// same locks, so one fetch serves all of them and none pays twice for a minute.
// Quota is a machine-global fact, so the dev/installed userData split does not
// apply here.

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

// Resolved here rather than imported from the SDK, so the read half stays
// importable without loading π at all.
function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR
  if (configured !== undefined && configured !== '') {
    return configured.startsWith('~') ? join(homedir(), configured.slice(1)) : configured
  }
  return join(homedir(), '.pi', 'agent')
}

/** `dir` overrides the location, which is how a test stays off the real cache. */
export function quotaCacheDir(dir?: string): string {
  return dir ?? join(agentDir(), 'usage')
}

export function cacheFile(providerId: string, dir?: string): string {
  if (!isSafeProviderId(providerId)) throw new Error(`unsafe provider id: ${providerId}`)
  return join(quotaCacheDir(dir), `${providerId}.json`)
}

/** Per provider, so one provider's outage cannot deny the others. */
export function lockFile(providerId: string, dir?: string): string {
  return `${cacheFile(providerId, dir)}.lock`
}
