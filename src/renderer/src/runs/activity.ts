import type { SessionId } from '../../../shared/agent/port'
import { runIsLive, type RunRecord } from '../../../shared/workflows/run'

// What the rail knows about runs, and the whole of it: a session whose own
// turn ended can still have a run burning money in a worktree in its name.
// Pure, because the arithmetic is the part worth testing without a DOM.

/** The rail's view of one session's live runs; absent when it has none. */
export interface RunActivity {
  /** Oldest live run's start (ISO); the counter shows shortAge of it. */
  readonly since: string
  /** True while any live run is running; false when every one is paused. */
  readonly moving: boolean
}

/**
 * Run activity per session, across every workspace: the rail lists all of
 * them. A run with no session marks nothing — unattended runs live in ⌘R.
 */
export function runActivity(
  runs: readonly RunRecord[]
): Readonly<Record<SessionId, RunActivity>> {
  const bySession: Record<SessionId, RunActivity> = {}
  for (const run of runs) {
    const sessionId = run.sessionId
    if (sessionId === undefined || !runIsLive(run)) continue
    // A live record that has not started yet still has an age to show, so the
    // dots never stand over an empty counter.
    const since = run.startedAt ?? run.createdAt
    const held = bySession[sessionId]
    bySession[sessionId] = {
      since: held === undefined || startedAt(since) < startedAt(held.since) ? since : held.since,
      moving: held?.moving === true || run.status === 'running'
    }
  }
  return bySession
}

/** An unreadable stamp sorts last, so one bad record cannot own the counter. */
function startedAt(iso: string): number {
  const at = Date.parse(iso)
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at
}
