import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'

// The other half of ADR 0014. `.crucible/worktree` is the whole mechanism for
// making a worktree, which is why a run cannot use it: a run's worktree is
// branched from a commit named at kickoff and may have to continue a
// predecessor's branch (ADR 0016), and none of that is a script's to decide.
//
// What a repository does know, and Crucible never can, is what turns a fresh
// checkout into one an agent can work in: the env file, the install, the
// generated code. That part is separable, so it is separate. This script runs
// inside a worktree that already exists, and it is the only thing a repo has
// to write for runs to work.

/** What a repository claims the mechanism by placing there. */
const SCRIPT = join('.crucible', 'worktree-setup')

/** An install can be slow; a hung one must not park a kickoff forever. */
const TIMEOUT_MS = 10 * 60_000

export interface SetupOutcome {
  readonly ok: boolean
  /** Absent when there was no script to run. */
  readonly ran: boolean
  /** Everything the script said, for a human who has to fix it. */
  readonly output: string
}

/** Whether the repository has one, without running anything. */
export function hasWorktreeSetup(workspacePath: string): boolean {
  return existsSync(join(workspacePath, SCRIPT))
}

/**
 * Run the repository's setup script inside a worktree that already exists.
 * A repository with no script needs no setup, which is a success.
 */
export async function setUpWorktree(
  workspacePath: string,
  worktreePath: string
): Promise<SetupOutcome> {
  const script = join(workspacePath, SCRIPT)
  // Presence decides, not executability: the file's existence is the repo
  // claiming the mechanism, so an unusable one fails rather than being
  // skipped behind the repo's back.
  if (!existsSync(script)) return { ok: true, ran: false, output: '' }

  try {
    await access(script, constants.X_OK)
  } catch {
    return {
      ok: false,
      ran: false,
      output: `${SCRIPT} is not executable\nchmod +x ${SCRIPT}\n`
    }
  }

  const ran = await run(script, worktreePath)
  if (ran.timedOut) {
    return {
      ok: false,
      ran: true,
      output: `${SCRIPT} did not finish within ${TIMEOUT_MS / 60_000} minutes\n${ran.output}`
    }
  }
  if (ran.code !== 0) {
    return {
      ok: false,
      ran: true,
      output: `${SCRIPT} exited ${ran.code ?? 'without a status'}\n${ran.output}`
    }
  }
  return { ok: true, ran: true, output: ran.output }
}

interface Ran {
  readonly code?: number
  readonly timedOut: boolean
  /** stdout and stderr interleaved, which is what a reader wants. */
  readonly output: string
}

// Run from inside the worktree, with no arguments and no Crucible-specific
// environment: where it is, is what it is told.
function run(script: string, cwd: string): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(script, [], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let timedOut = false
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      output += chunk
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, TIMEOUT_MS)

    let settled = false
    const settle = (ran: Ran): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ran)
    }
    child.on('error', (cause: Error) =>
      settle({ timedOut, output: `${output}${cause.message}\n` })
    )
    child.on('close', (code) =>
      settle({ timedOut, output, ...(code === null ? {} : { code }) })
    )
  })
}
