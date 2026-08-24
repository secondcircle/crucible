import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { capture } from '../workspace/capture'
import {
  BASE_VAR,
  BRANCH_VAR,
  WORKTREE_SCRIPT,
  branchOf,
  hasWorktreeScript,
  runWorktreeScript
} from '../workspace/worktree-script'
import { setUpWorktree } from '../workspace/worktree-setup'

// A run's worktree is made the same two ways a session's is: the repository's
// own `.crucible/worktree` when it has one, plain git plus
// `.crucible/worktree-setup` when it does not. What differs is what the
// script is told — the base commit, and for a chained successor the branch to
// continue — and that Crucible verifies what came back rather than trusting
// it, because a script that ignores the base leaves the run working on the
// wrong commit with nobody the wiser. A mismatch refuses the run at kickoff,
// before a node has cost anything. Nothing here ever removes a worktree or a
// branch, verification failure included.

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
  // Presence decides, not executability, exactly as it does for a session: a
  // file that exists but cannot be run is a refusal, never a quiet
  // fall-through to git.
  return hasWorktreeScript(request.workspacePath)
    ? await fromScript(request)
    : await fromGit(request)
}

// The whole mechanism when the repository has one. It is told the base as a
// full sha, and a chained successor's branch when there is one; it reports a
// *ready* worktree, so setup is not run afterwards and none of the plain-git
// path's directories or ignore files are made.
async function fromScript(request: RunWorktreeRequest): Promise<RunWorktree> {
  const { workspacePath, runId } = request
  // Before the script is invoked at all: a base that names no commit is
  // Crucible's own refusal, not something a script should be handed.
  const baseCommit = await resolveBase(workspacePath, request.base)

  const ran = await runWorktreeScript(workspacePath, {
    base: baseCommit,
    ...(request.branch === undefined ? {} : { branch: request.branch })
  })
  if (!ran.ok) throw new Error(`the worktree for run ${runId} could not be created\n${ran.output}`)

  const head = await capture('git', ['-C', ran.path, 'rev-parse', 'HEAD'])
  if (head.code !== 0) {
    throw new Error(
      `${WORKTREE_SCRIPT} reported a worktree whose HEAD cannot be read: ${ran.path}\n` +
        `${head.output}${ran.output}`
    )
  }
  if (head.stdout.trim() !== baseCommit) {
    throw new Error(
      `${WORKTREE_SCRIPT} left run ${runId} on the wrong commit\n` +
        `  ${ran.path} is at ${head.stdout.trim()}\n` +
        `  ${BASE_VAR} asked for ${baseCommit}\n` +
        ran.output
    )
  }

  const branch = await branchOf(ran.path)
  if (branch === undefined) {
    // A run's completion names its branch and a chained successor continues
    // it, so a detached HEAD is a failure discovered now rather than at the
    // end of a run that has already been paid for.
    throw new Error(
      `${WORKTREE_SCRIPT} left run ${runId} on no branch\n` +
        `  ${ran.path} has a detached HEAD, and a run's work has to land on a branch\n` +
        ran.output
    )
  }
  if (request.branch !== undefined && branch !== request.branch) {
    throw new Error(
      `${WORKTREE_SCRIPT} left run ${runId} on the wrong branch\n` +
        `  ${ran.path} is on ${branch}\n` +
        `  ${BRANCH_VAR} asked for ${request.branch}\n` +
        ran.output
    )
  }

  return { path: ran.path, branch, baseCommit }
}

// Plain git for a repository that owns no creation script: the same
// directory family as session worktrees, the same self-ignoring .gitignore,
// then the repository's setup.
async function fromGit(request: RunWorktreeRequest): Promise<RunWorktree> {
  const { workspacePath, runId } = request
  const root = join(workspacePath, WORKTREES)
  selfIgnoring(root)

  const path = join(root, `run-${runId}`)
  if (existsSync(path)) throw new Error(`the worktree directory already exists: ${path}`)

  const baseCommit = await resolveBase(workspacePath, request.base)

  const branch = request.branch ?? `crucible/run-${runId}`
  const args =
    request.branch === undefined
      ? // A fresh branch at the named commit.
        ['-C', workspacePath, 'worktree', 'add', '-b', branch, path, baseCommit]
      : // Continue the predecessor's branch, whose tip is the named commit.
        // Forced, because the branch is still checked out in the
        // predecessor's worktree — kept forever — and git would
        // otherwise refuse the second checkout. The predecessor is done;
        // nothing works there again.
        ['-C', workspacePath, 'worktree', 'add', '--force', path, branch]
  const added = await capture('git', args)
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

/** The run's base as a full sha, in the checkout, before anything is made. */
async function resolveBase(workspacePath: string, base: string): Promise<string> {
  const resolved = await capture('git', [
    '-C',
    workspacePath,
    'rev-parse',
    '--verify',
    `${base}^{commit}`
  ])
  if (resolved.code !== 0) {
    throw new Error(`"${base}" names no commit in ${workspacePath}\n${resolved.output}`)
  }
  return resolved.stdout.trim()
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
  const staged = await capture('git', ['-C', worktreePath, 'add', '-A'])
  if (staged.code !== 0) throw new Error(`git add failed in ${worktreePath}\n${staged.output}`)

  const anything = await capture('git', ['-C', worktreePath, 'diff', '--cached', '--quiet'])
  let committed = false
  if (anything.code !== 0) {
    const done = await capture('git', ['-C', worktreePath, 'commit', '-m', message])
    if (done.code !== 0) throw new Error(`git commit failed in ${worktreePath}\n${done.output}`)
    committed = true
  }

  const tip = await capture('git', ['-C', worktreePath, 'rev-parse', 'HEAD'])
  if (tip.code !== 0) throw new Error(`git rev-parse failed in ${worktreePath}\n${tip.output}`)
  return { commit: tip.stdout.trim(), committed }
}

/** HEAD of any directory inside a repository, as a full sha. */
export async function headOf(directory: string): Promise<string> {
  const tip = await capture('git', ['-C', directory, 'rev-parse', 'HEAD'])
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
  const common = await capture('git', [
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
