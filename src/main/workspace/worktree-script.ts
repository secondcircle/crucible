import { existsSync, statSync } from 'node:fs'
import { access, constants } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { capture, headline, lastLine } from './capture'

// One script owns worktree creation for sessions and runs both. A session's
// invocation is bare and the script picks everything; a run's names the base
// commit, and a chained successor's also names the branch to continue. Which
// variables exist is how a script tells the three cases apart, so the caller
// that has nothing to say says nothing at all.
//
// This module runs the script and checks the one thing every caller checks:
// that what came back is an absolute path to a directory. What a run
// additionally verifies about that worktree — commit and branch — belongs to
// the run, and lives with it.

/** What a repository claims the creation mechanism by placing there. */
export const WORKTREE_SCRIPT = join('.crucible', 'worktree')

/** Told to the script through the environment; a session is told neither. */
export const BASE_VAR = 'CRUCIBLE_WORKTREE_BASE'
export const BRANCH_VAR = 'CRUCIBLE_WORKTREE_BRANCH'

export interface WorktreeScriptInvocation {
  /** A run's base, as a full sha. Absent means a session. */
  readonly base?: string
  /** The branch a chained successor continues. Absent means a fresh branch. */
  readonly branch?: string
}

export type WorktreeScriptOutcome =
  | { readonly ok: true; readonly path: string; readonly output: string }
  | { readonly ok: false; readonly output: string }

/** Whether the repository owns creation, without running anything. */
export function hasWorktreeScript(workspacePath: string): boolean {
  return existsSync(join(workspacePath, WORKTREE_SCRIPT))
}

/**
 * Run the repository's creation script from the checkout and read back the
 * worktree it reports. Presence of the file decides that this is the
 * mechanism; a file that cannot be executed fails here rather than falling
 * through to git behind the repository's back.
 */
export async function runWorktreeScript(
  workspacePath: string,
  invocation: WorktreeScriptInvocation = {}
): Promise<WorktreeScriptOutcome> {
  const script = join(workspacePath, WORKTREE_SCRIPT)
  try {
    await access(script, constants.X_OK)
  } catch {
    return {
      ok: false,
      output: `${WORKTREE_SCRIPT} is not executable\nchmod +x ${WORKTREE_SCRIPT}\n`
    }
  }

  const ran = await capture(script, [], {
    cwd: workspacePath,
    ...(invocation.base === undefined && invocation.branch === undefined
      ? {}
      : {
          env: {
            ...(invocation.base === undefined ? {} : { [BASE_VAR]: invocation.base }),
            ...(invocation.branch === undefined ? {} : { [BRANCH_VAR]: invocation.branch })
          }
        })
  })
  if (ran.code !== 0) {
    return { ok: false, output: `${headline(WORKTREE_SCRIPT, ran)}\n${ran.output}` }
  }

  const reported = lastLine(ran.stdout)
  if (reported === undefined) {
    return {
      ok: false,
      output: `${WORKTREE_SCRIPT} exited 0 without reporting a worktree path\n${ran.output}`
    }
  }
  if (!isAbsolute(reported) || !directoryExists(reported)) {
    return {
      ok: false,
      output:
        `${WORKTREE_SCRIPT} reported a path that is not a worktree: ${reported}\n` + ran.output
    }
  }

  return { ok: true, path: reported, output: ran.output }
}

/** Empty or unreadable leaves the branch unknown, which each caller judges. */
export async function branchOf(path: string): Promise<string | undefined> {
  const ran = await capture('git', ['-C', path, 'branch', '--show-current'])
  if (ran.code !== 0) return undefined
  const named = ran.stdout.trim()
  return named === '' ? undefined : named
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
