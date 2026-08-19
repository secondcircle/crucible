import type { SessionState } from '../../shared/agent/port'

// Session naming is deferred, so a session is labelled by when it was created
// and nothing else. The format lives here so the sidebar and the top bar cannot
// drift into two names for one session.
export function sessionLabel(session: Pick<SessionState, 'createdAt'>): string {
  const at = new Date(session.createdAt)
  if (Number.isNaN(at.getTime())) return 'Session'
  return `Session · ${at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}

/** How long ago, in the shorthand a search result has room for. */
export function relativeTime(iso: string, now = Date.now()): string {
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return ''
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days}d ago`
}

/** Whole thousands, the way a context meter says them: `68k`. */
export function tokens(count: number): string {
  if (count < 1000) return String(count)
  return `${Math.round(count / 100) / 10}k`
}
