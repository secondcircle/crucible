import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { discoverBash, type BashLocation, type MachineBashView } from './bash'

// The one module that knows this app runs on more than one OS. Everything that
// spawns a shell or kills a process tree asks here; no caller learns Windows
// exists.

function thisMachine(): MachineBashView {
  return {
    platform: process.platform,
    path: process.env.PATH ?? '',
    exists: existsSync
  }
}

// Found once per launch: PATH does not change under a running app, and a bash
// run should not pay for a directory walk.
let found: BashLocation | undefined

/**
 * Where bash is, or why it could not be found. The caller renders the failure
 * — a bash run that fails silently is a defect.
 */
export function bashLocation(view: MachineBashView = thisMachine()): BashLocation {
  if (found === undefined) found = discoverBash(view)
  return found
}

export type ScriptSpawn =
  | { readonly ok: true; readonly command: string; readonly args: readonly string[] }
  /** Said to the person by whoever wanted the script run. */
  | { readonly ok: false; readonly message: string }

/**
 * How to run a repository-owned script — `.crucible/worktree`,
 * `.crucible/worktree-setup`. A shebang is a POSIX fact, so on Windows the
 * script cannot be spawned directly and goes through the same bash.
 *
 * Without that bash the answer is a refusal, never a bare `bash`: on Windows
 * a bare lookup finds WSL, and a repository script that ran there would run
 * against another filesystem and say nothing about it.
 */
export function scriptSpawn(script: string): ScriptSpawn {
  if (process.platform !== 'win32') return { ok: true, command: script, args: [] }
  const bash = bashLocation()
  if (!bash.ok) return { ok: false, message: bash.message }
  return { ok: true, command: bash.path, args: [toPosixPath(script)] }
}

/** Git Bash reads its own paths, and `C:\a\b` is not one of them. */
export function toPosixPath(path: string): string {
  const drive = /^([A-Za-z]):[\\/]/.exec(path)
  const rest = drive === null ? path : path.slice(3)
  const posix = rest.replaceAll('\\', '/')
  return drive === null ? posix : `/${drive[1].toLowerCase()}/${posix}`
}

/**
 * Kills a process and everything it started. `process.kill(-pid)` is a POSIX
 * process group and means nothing on Windows, where the tree is taskkill's
 * job. Every tree kill in the app goes through here.
 */
export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    // Fire and forget: the caller has already decided the tree is over, and
    // a process that had already exited is the outcome asked for.
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {})
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // Already gone, which is the outcome asked for.
  }
}
