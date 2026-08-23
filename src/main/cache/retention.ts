import type { CacheRetention, RetentionSource } from '../../shared/agent/port'

// π's `PI_CACHE_RETENTION`: `long` asks Anthropic for one-hour prompt
// retention, anything else leaves the five-minute default. Crucible asks for
// the hour for every agent it starts — sessions, orchestrators and workflow
// nodes, single-shot fresh-context nodes included — by writing the variable
// itself when the launch did not carry one. π reads it per request, so this
// one write covers the SDK adapter's sessions and every node session alike.
// A variable already set is the user's override and is never touched; there
// is no Settings toggle.
//
// The breadth is deliberate, and it is the part that looks like a bug. Issue
// #13 proposed excluding fresh-context nodes on the theory that a node which
// starts clean, runs straight through and exits pays the write premium and
// never reads it back. The ledger's first sample said otherwise: the single
// most expensive miss the hour would have saved was a `build`/`planner`
// fresh-context node, $0.71 and 61k tokens re-billed after a 5.4-minute gap
// between two turns of its own conversation. That gap held no slow tool call
// — all 29 of the node's bash calls were sub-second — just one enormous
// extended-thinking block. The cache expired during a single turn's own
// generation. The line that predicts a miss is not "does this agent wait" but
// "can five minutes pass between two turns", which is true of nearly
// everything Crucible starts.
//
// No ADR: the change is one line and trivially reversible, and whether the
// hour pays for itself is a directional read of the ledger, which records the
// retention against every miss for exactly that reason.

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
