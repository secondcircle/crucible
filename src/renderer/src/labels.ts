import type { SessionWorktree } from '../../shared/agent/port'

// The small display formats, in one place so two components cannot drift into
// two spellings of one fact. `sessionLabel` is gone: the model writes the
// title now.

// The branch when it is known, and the directory's own name when a script made
// a worktree whose branch could not be read.
export function worktreeLabel(worktree: SessionWorktree): string {
  if (worktree.branch !== undefined && worktree.branch !== '') return worktree.branch
  return worktree.path.split('/').filter(Boolean).at(-1) ?? worktree.path
}

/** The clock time a tree node carries: `2:04 PM`, and nothing when unknown. */
export function clockTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
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

/** How long ago a board was collected: `40s`, `3m`, `2h`. */
export function boardAge(collectedAt: string, now = Date.now()): string {
  const at = new Date(collectedAt).getTime()
  if (Number.isNaN(at)) return ''
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]

const DAY_MS = 24 * 60 * 60 * 1000

// A branch's age: days while the number still means something, then the date
// it was last touched, and the year once that date is ambiguous.
export function branchAge(touchedAt: string, now = Date.now()): string {
  const when = new Date(touchedAt)
  const at = when.getTime()
  if (Number.isNaN(at)) return ''
  const days = Math.floor(Math.max(0, now - at) / DAY_MS)
  if (days < 7) return `${days}d`
  const date = `${when.getDate()} ${MONTHS[when.getMonth()]}`
  return days > 365 ? `${date} ${when.getFullYear()}` : date
}

// An issue's age, in the unit that still means something at that distance:
// hours on the day it moved, days for a fortnight, then weeks and years. The
// column is 40px wide, so nothing here may be longer than three characters.
export function issueAge(at: string, now = Date.now()): string {
  const when = new Date(at).getTime()
  if (Number.isNaN(when)) return ''
  const minutes = Math.max(0, Math.floor((now - when) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (days < 365) return `${weeks}w`
  return `${Math.floor(days / 365)}y`
}

// How long the running turn has been running: seconds while it is short, then
// m:ss, then hours and minutes, because nobody watches the seconds on an hour
// old turn. Monospaced and tabular where it renders, so it never shifts width
// as it ticks.
export function elapsedTime(iso: string, now = Date.now()): string {
  const from = new Date(iso).getTime()
  if (Number.isNaN(from)) return ''
  const seconds = Math.max(0, Math.floor((now - from) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  }
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

// The meter's percentage, and nothing at all until the adapter has reported
// real usage: one reading, so the top bar and the Usage tab cannot disagree.
export function contextPercent(
  usage: { readonly usedTokens: number; readonly contextWindow: number } | undefined
): number | undefined {
  if (usage === undefined || usage.contextWindow <= 0) return undefined
  return Math.min(100, Math.round((usage.usedTokens / usage.contextWindow) * 100))
}

/** Whole thousands, the way a context meter says them: `68k`. */
export function tokens(count: number): string {
  if (count < 1000) return String(count)
  return `${Math.round(count / 100) / 10}k`
}
