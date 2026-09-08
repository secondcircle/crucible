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

export function waitedFor(since: string, now = Date.now()): string {
  const started = Date.parse(since)
  if (Number.isNaN(started)) return ''
  return briefDuration(Math.max(0, now - started))
}

export function elapsedFraction(monitor: LiveMonitor, now: number): number {
  const started = Date.parse(monitor.setAt)
  if (Number.isNaN(started) || monitor.timeoutMs <= 0) return 0
  return Math.min(1, Math.max(0, (now - started) / monitor.timeoutMs))
}

export function inlineOutput(monitor: LiveMonitor): string | undefined {
  const text = monitor.last?.output.text
  if (text === undefined) return undefined
  const line = text.split('\n').find((candidate) => candidate.trim() !== '')
  return line === undefined ? undefined : line.trim()
}

function setAt(iso: string): number {
  const at = Date.parse(iso)
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at
}
