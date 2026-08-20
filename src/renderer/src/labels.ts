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
