import { basename, sep } from 'node:path'

// Which state directory a dev launch runs against, and the badge that names
// it. One computation, so the directory the window can see runs and the mark
// it shows can never disagree: the badge is the state dir's own suffix,
// because that suffix is exactly what decides which runs and sessions the
// window has.
//
// The installed app gets neither: its state is `Crucible`, and the badge marks
// the exceptional case rather than the daily one.

export interface DevInstance {
  /** Directory name under `appData`, never a full path. */
  readonly stateDir: string
  /** What the top bar shows: `dev`, or `dev · <suffix>` in a worktree launch. */
  readonly badge: string
}

/**
 * The dev instance a checkout runs as. A run worktree gets its own state
 * directory, because concurrent builds would otherwise write one another's
 * sessions and config; the human's own checkout keeps the plain `Crucible-Dev`
 * it has always had. The matching per-checkout debug port lives in
 * `scripts/dev-port.sh`.
 */
export function devInstance(appPath: string): DevInstance {
  const inRunWorktree = appPath.includes(`${sep}.crucible${sep}worktrees${sep}`)
  if (!inRunWorktree) return { stateDir: 'Crucible-Dev', badge: 'dev' }
  const suffix = basename(appPath)
  return { stateDir: `Crucible-Dev-${suffix}`, badge: `dev · ${suffix}` }
}
