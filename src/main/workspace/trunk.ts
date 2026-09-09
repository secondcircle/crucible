import { parseTrunkRef } from './repository-facts'

// Which branch is the trunk, and how the refs it is judged against are
// refreshed. A scheduled run asks so it branches from the trunk tip rather
// than from whatever this checkout happens to be sitting on. One rule, one
// module: two answers to "which branch is the trunk" would be two behaviors
// nobody chose.

/** Enough of a command outcome to decide with; the callers' runners fit it. */
export interface GitAnswer {
  readonly ok: boolean
  readonly stdout: string
}

export type GitRunner = (...args: readonly string[]) => Promise<GitAnswer>

export interface Trunk {
  /** The branch name, as a person says it: `main`. */
  readonly name: string
  /** The ref to read it from: `refs/remotes/origin/main` or `refs/heads/main`. */
  readonly ref: string
}

/**
 * Brings the remote-tracking refs up to date, and says whether there is an
 * origin at all. Nothing else is touched: not the working tree, not the
 * index, not a local branch. A fetch that fails is tolerated and the refs on
 * hand stand — offline is not a reason to refuse.
 */
export async function refreshRefs(git: GitRunner): Promise<{ readonly originUrl: string }> {
  const origin = await git('remote', 'get-url', 'origin')
  const originUrl = origin.ok ? origin.stdout.trim() : ''
  if (originUrl !== '') await git('fetch', '--prune', 'origin')
  return { originUrl }
}

/** The remote default branch, then a local main, then a local master. */
export async function findTrunk(git: GitRunner, hasOrigin: boolean): Promise<Trunk | undefined> {
  if (hasOrigin) {
    const pointer = await git('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD')
    const name = pointer.ok ? parseTrunkRef(pointer.stdout) : undefined
    if (name !== undefined) return { name, ref: `refs/remotes/origin/${name}` }
  }
  for (const name of ['main', 'master']) {
    const local = await git('show-ref', '--verify', '--quiet', `refs/heads/${name}`)
    if (local.ok) return { name, ref: `refs/heads/${name}` }
  }
  return undefined
}

/** The one sentence a repository with no discoverable trunk is refused with. */
export const NO_TRUNK =
  'Crucible could not tell which branch is the trunk here — no origin/HEAD, main or master.'
