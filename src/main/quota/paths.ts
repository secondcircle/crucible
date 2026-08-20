import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where the quota cache lives, and what a cache file is.
 *
 * One JSON file per provider under `~/.pi/agent/usage/`, honoring
 * `PI_CODING_AGENT_DIR`. That path is the one place the old word survives, and
 * deliberately: the layout is an interop contract, not Crucible code. The
 * legacy system's dashboard and its detached runner already read and write
 * these files under cross-process locks, so sharing them means a machine's
 * apps cooperate on one cache — a reading either side fetched serves both,
 * launch paint has data on the first run, and no provider pays twice for the
 * same minute.
 *
 * The cache is not session state, so the dev/installed `userData` split does
 * not apply to it: quota is a machine-global fact, and two Crucible instances
 * sharing it is the point rather than a leak.
 *
 * The agent dir is resolved here rather than imported from the π SDK, because
 * the read half must stay importable without loading π at all. It mirrors that
 * package's own rule: `PI_CODING_AGENT_DIR` if set, else `~/.pi/agent`.
 */

/** Cache schema version. A mismatch discards the file rather than parsing it. */
export const CACHE_SCHEMA_VERSION = 1

/**
 * The provider ids this module can publish — the ones with a verified adapter.
 *
 * It lives here, beside the file layout, because both halves need it and
 * neither should learn it from the other: the reader filters cache files by it,
 * so a provider with no adapter is absent from the very first cache-only
 * snapshot rather than only after a store has run and pruned. The store's own
 * registry is checked against this list by a test, so adding an adapter means
 * adding its id here in the same commit.
 */
export const KNOWN_PROVIDER_IDS: readonly string[] = ['anthropic', 'openai-codex', 'xai']

/** Provider ids become file names, so they may not become paths. */
const SAFE_PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/i

export function isSafeProviderId(providerId: string): boolean {
  return SAFE_PROVIDER_ID.test(providerId) && !providerId.includes('..')
}

function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR
  if (configured !== undefined && configured !== '') {
    return configured.startsWith('~') ? join(homedir(), configured.slice(1)) : configured
  }
  return join(homedir(), '.pi', 'agent')
}

/** The cache directory; `dir` overrides it, which is the tests' fixture seam. */
export function quotaCacheDir(dir?: string): string {
  return dir ?? join(agentDir(), 'usage')
}

/** One provider's cache file. */
export function cacheFile(providerId: string, dir?: string): string {
  if (!isSafeProviderId(providerId)) throw new Error(`unsafe provider id: ${providerId}`)
  return join(quotaCacheDir(dir), `${providerId}.json`)
}

/** One provider's lock file. Per provider, so one outage cannot deny the others. */
export function lockFile(providerId: string, dir?: string): string {
  return `${cacheFile(providerId, dir)}.lock`
}
