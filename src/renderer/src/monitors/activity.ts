import type { SessionId } from '../../../shared/agent/port'
import type { LiveMonitor } from '../../../shared/monitors/monitor'
import type { MonitorsSnapshot } from '../../../shared/monitors/service'
import { briefDuration } from '../../../shared/monitors/wording'

// What the rail and the strip derive from the monitor snapshot, and the whole
// of it. Pure, because the arithmetic is the part worth testing without a DOM.

/** The rail's view of one session's live monitors; absent when it has none. */
export interface MonitorActivity {
  /** The longest wait's start (ISO); the ⏳ shows its age. */
  readonly since: string
}

/**
 * Per session, the `setAt` of its longest-waiting live monitor. A monitor
 * belongs to exactly one session, and a node's never crosses this seam at all.
 */
export function monitorActivity(
  snapshot: MonitorsSnapshot
): Readonly<Record<SessionId, MonitorActivity>> {
  const bySession: Record<SessionId, MonitorActivity> = {}
  for (const monitor of snapshot.monitors) {
    const held = bySession[monitor.sessionId]
    if (held === undefined || setAt(monitor.setAt) < setAt(held.since)) {
      bySession[monitor.sessionId] = { since: monitor.setAt }
    }
  }
  return bySession
}

// How long a wait has run, in the chips' units. Every monitor surface says it
// through here — the chip, the sidebar's ⏳, a run chip and a node header — so
// no two of them can report one wait two ways.
export function waitedFor(since: string, now = Date.now()): string {
  const started = Date.parse(since)
  if (Number.isNaN(started)) return ''
  return briefDuration(Math.max(0, now - started))
}

/** 0 to 1 of the timeout elapsed since the monitor was set: the hairline. */
export function elapsedFraction(monitor: LiveMonitor, now: number): number {
  const started = Date.parse(monitor.setAt)
  if (Number.isNaN(started) || monitor.timeoutMs <= 0) return 0
  return Math.min(1, Math.max(0, (now - started) / monitor.timeoutMs))
}

/**
 * The chip's inline line: the first line of the retained output that says
 * anything, or nothing at all. A chatty check gets one line on the chip and
 * the whole of what was kept in the detail.
 */
export function inlineOutput(monitor: LiveMonitor): string | undefined {
  const text = monitor.last?.output.text
  if (text === undefined) return undefined
  const line = text.split('\n').find((candidate) => candidate.trim() !== '')
  return line === undefined ? undefined : line.trim()
}

/** An unreadable stamp sorts last, so one bad record cannot own the counter. */
function setAt(iso: string): number {
  const at = Date.parse(iso)
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at
}
