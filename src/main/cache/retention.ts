import type { CacheRetention, RetentionSource } from '../../shared/agent/port'

// π's `PI_CACHE_RETENTION`: `long` asks Anthropic for one-hour prompt
// retention, anything else leaves the five-minute default. Crucible asks for
// the hour for every agent it starts. Single-shot fresh-context nodes look
// like the obvious exemption and are not: the most expensive miss in the
// ledger is one of those, $0.71 and 61k tokens re-billed because five minutes
// passed inside a single turn's own generation, no slow tool call in the gap.
// What predicts a miss is not whether an agent waits but whether five minutes
// can pass between two of its turns, which is true of nearly everything here.
// π reads the variable per request, so one write covers every agent this
// launch starts. A variable already set is the user's override and is never
// touched; there is no Settings toggle.

export interface RetentionDecision {
  readonly retention: CacheRetention
  /** Whoever actually decided, which is what the UI names. */
  readonly source: RetentionSource
}

// Decided from the environment as it was before the default was applied, and
// remembered per environment so asking twice changes nothing and answers the
// same. Without this memory the two are indistinguishable a moment later: an
// env carrying `long` because Crucible wrote it reads exactly like one the
// user exported.
const decided = new WeakMap<NodeJS.ProcessEnv, RetentionDecision>()

// Applies Crucible's default and answers with what is in force. The env is
// injectable and the only one this ever writes to: nothing reaches for
// `process.env` behind a test's back.
export function retentionInForce(env: NodeJS.ProcessEnv = process.env): RetentionDecision {
  const already = decided.get(env)
  if (already !== undefined) return already

  const set = env.PI_CACHE_RETENTION
  const decision: RetentionDecision =
    set === undefined
      ? { retention: '1h', source: 'crucible' }
      : { retention: set === 'long' ? '1h' : '5m', source: 'env' }
  if (set === undefined) env.PI_CACHE_RETENTION = 'long'
  decided.set(env, decision)
  return decision
}
