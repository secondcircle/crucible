import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setUpWorktree } from '../workspace/worktree-setup'

// Run worktrees are plain git on purpose: a run's base is a commit named at
// kickoff (ADR 0016), and the repo worktree script of ADR 0014 takes no base
// argument — it exists to provision a session's worktree from the checkout's
// HEAD. Same directory family as session worktrees, same self-ignoring
// .gitignore, and nothing here ever removes a worktree or a branch.

const WORKTREES = join('.crucible', 'worktrees')

export interface RunWorktreeRequest {
  /** The workspace checkout the repository lives in. */
  readonly workspacePath: string
  readonly runId: string
  /** Commit-ish the run branches from; resolved to a commit before use. */
  readonly base: string
  /** An existing branch to continue (a chained successor); absent mints one. */
  readonly branch?: string
}

export interface RunWorktree {
  readonly path: string
  readonly branch: string
  /** The commit the worktree was created at, as a full sha. */
  readonly baseCommit: string
}

export async function createRunWorktree(request: RunWorktreeRequest): Promise<RunWorktree> {
  const { workspacePath, runId } = request
  const root = join(workspacePath, WORKTREES)
  selfIgnoring(root)

  const path = join(root, `run-${runId}`)
  if (existsSync(path)) throw new Error(`the worktree directory already exists: ${path}`)

  const resolved = await run('git', [
    '-C',
    workspacePath,
    'rev-parse',
    '--verify',
    `${request.base}^{commit}`
  ])
  if (resolved.code !== 0) {
    throw new Error(`"${request.base}" names no commit in ${workspacePath}\n${resolved.output}`)
  }
  const baseCommit = resolved.stdout.trim()

  const branch = request.branch ?? `crucible/run-${runId}`
  const args =
    request.branch === undefined
      ? // A fresh branch at the named commit.
        ['-C', workspacePath, 'worktree', 'add', '-b', branch, path, baseCommit]
      : // Continue the predecessor's branch, whose tip is the named commit.
        // Forced, because the branch is still checked out in the
        // predecessor's worktree — kept forever by ADR 0014 — and git would
        // otherwise refuse the second checkout. The predecessor is done;
        // nothing works there again.
        ['-C', workspacePath, 'worktree', 'add', '--force', path, branch]
  const added = await run('git', args)
  if (added.code !== 0) {
    throw new Error(`git worktree add failed for run ${runId}\n${added.output}`)
  }

  // A worktree straight out of git is a checkout, not a working environment:
  // no node_modules, no env file, nothing the repository's own setup puts
  // there. Nodes run the project's checks, so failing here — before a single
  // node has cost anything — beats a run that spends its budget rediscovering
  // that it cannot build.
  const setUp = await setUpWorktree(workspacePath, path)
  if (!setUp.ok) {
    throw new Error(`the worktree for run ${runId} could not be set up\n${setUp.output}`)
  }

  return { path, branch, baseCommit }
}

/**
 * Commit everything the run's worktree holds, tracked or not. An empty tree
 * is a legitimate no-op. Either way the branch tip comes back, which is the
 * run's final commit.
 */
export async function commitRunWorktree(
  worktreePath: string,
  message: string
): Promise<{ readonly commit: string; readonly committed: boolean }> {
  const staged = await run('git', ['-C', worktreePath, 'add', '-A'])
  if (staged.code !== 0) throw new Error(`git add failed in ${worktreePath}\n${staged.output}`)

  const anything = await run('git', ['-C', worktreePath, 'diff', '--cached', '--quiet'])
  let committed = false
  if (anything.code !== 0) {
    const done = await run('git', ['-C', worktreePath, 'commit', '-m', message])
    if (done.code !== 0) throw new Error(`git commit failed in ${worktreePath}\n${done.output}`)
    committed = true
  }

  const tip = await run('git', ['-C', worktreePath, 'rev-parse', 'HEAD'])
  if (tip.code !== 0) throw new Error(`git rev-parse failed in ${worktreePath}\n${tip.output}`)
  return { commit: tip.stdout.trim(), committed }
}

/** HEAD of any directory inside a repository, as a full sha. */
export async function headOf(directory: string): Promise<string> {
  const tip = await run('git', ['-C', directory, 'rev-parse', 'HEAD'])
  if (tip.code !== 0) {
    throw new Error(`${directory} has no readable HEAD\n${tip.output}`)
  }
  return tip.stdout.trim()
}

/**
 * The checkout root a directory belongs to: the main working tree even when
 * the directory is itself a worktree, which is where run worktrees are made.
 */
export async function checkoutRootOf(directory: string): Promise<string> {
  const common = await run('git', [
    '-C',
    directory,
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir'
  ])
  if (common.code !== 0) {
    throw new Error(`${directory} is not inside a git repository\n${common.output}`)
  }
  const gitDir = common.stdout.trim()
  if (!gitDir.endsWith('/.git')) {
    // A bare repository has no checkout to put worktrees under.
    throw new Error(`${directory} belongs to a repository with no main checkout (${gitDir})`)
  }
  return gitDir.slice(0, -'/.git'.length)
}

/** Written once per workspace, exactly as the session-worktree module does. */
function selfIgnoring(root: string): void {
  mkdirSync(root, { recursive: true })
  const ignore = join(root, '.gitignore')
  if (existsSync(ignore)) return
  writeFileSync(ignore, '*\n', 'utf8')
}

interface Ran {
  readonly code?: number
  readonly stdout: string
  /** stdout and stderr interleaved, for error messages. */
  readonly output: string
}

function run(command: string, args: readonly string[]): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      output += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      output += chunk
    })
    let settled = false
    const settle = (ran: Ran): void => {
      if (settled) return
      settled = true
      resolve(ran)
    }
    child.on('error', (cause: Error) => settle({ stdout, output: `${output}${cause.message}\n` }))
    child.on('close', (code) => settle({ stdout, output, ...(code === null ? {} : { code }) }))
  })
}
