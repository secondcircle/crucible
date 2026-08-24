import type { CacheRetention } from '../../shared/agent/port'

// π's `PI_CACHE_RETENTION`: `long` asks Anthropic for one-hour prompt
// retention, anything else leaves the five-minute default. π reads the
// variable off the process environment at request time, and the SDK runs
// inside main, so main setting it is the whole mechanism — dev launches and
// the Dock-launched packaged app alike, neither of which inherits a shell.

/** The setting as π will read it. Pure: it answers, it does not choose. */
export function retentionInForce(env: NodeJS.ProcessEnv = process.env): CacheRetention {
  return env.PI_CACHE_RETENTION === 'long' ? '1h' : '5m'
}

/**
 * Crucible asks for the hour, unless the environment already said otherwise.
 * An explicit `PI_CACHE_RETENTION` wins, which is what keeps the before-and-
 * after in the ledger runnable: launch with `PI_CACHE_RETENTION=short` and the
 * same build records five-minute misses.
 *
 * Call before anything reads the setting — the ledger snapshots it at
 * construction, and so does every adapter.
 */
export function useLongRetention(env: NodeJS.ProcessEnv = process.env): CacheRetention {
  env.PI_CACHE_RETENTION ??= 'long'
  return retentionInForce(env)
}
