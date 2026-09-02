import { existsSync, statSync } from 'node:fs'
import { access, constants } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { scriptSpawn } from '../platform/exec'
import { capture, headline, lastLine } from './capture'

// Which variables exist is how the script tells its invocations apart, so a
// caller with nothing to say sets nothing at all. Only the check every
// caller shares lives here; what a run further verifies — commit and
// branch — belongs to the run.

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
 * Presence of the file made it the mechanism, so one that cannot be executed
 * fails here, never a quiet fall-through to git.
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

  const spawning = scriptSpawn(script)
  if (!spawning.ok) return { ok: false, output: `${spawning.message}\n` }

  const ran = await capture(spawning.command, spawning.args, {
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
