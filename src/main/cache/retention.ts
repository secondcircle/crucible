import type { CacheRetention } from '../../shared/agent/port'

// π's `PI_CACHE_RETENTION`: `long` asks Anthropic for one-hour prompt
// retention, anything else leaves the five-minute default. Crucible reads the
// setting and records it against every miss; it never sets it. Whether
// orchestrator sessions should run the hour is the question the ledger exists
// to answer.

export function retentionInForce(env: NodeJS.ProcessEnv = process.env): CacheRetention {
  return env.PI_CACHE_RETENTION === 'long' ? '1h' : '5m'
}
