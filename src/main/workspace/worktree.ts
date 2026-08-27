import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorktreeCreation } from '../../shared/workspace/service'
import { capture, headline } from './capture'
import { setUpWorktree } from './worktree-setup'
import { branchOf, hasWorktreeScript, runWorktreeScript } from './worktree-script'

// Creating a worktree is a process, so it lives behind the workspace service
// with the rest of the OS facts. Two mechanisms and no third: the repo's own
// script when it has one, plain git when it does not. Nothing here removes a
// worktree, a branch or a directory, under any outcome.

/** Where the fallback puts what it makes, and what it ignores itself with. */
const WORKTREES = join('.crucible', 'worktrees')

const IGNORE_EVERYTHING = '*\n'

/** Room enough that a collision is a curiosity rather than a wait. */
const MINT_ATTEMPTS = 20

export async function isGitWorkspace(workspacePath: string): Promise<boolean> {
  const ran = await capture('git', ['-C', workspacePath, 'rev-parse', '--is-inside-work-tree'])
  return ran.code === 0 && ran.stdout.trim() === 'true'
}

export async function createWorktree(workspacePath: string): Promise<WorktreeCreation> {
  // Presence decides, not executability: the file's existence is the repo
  // claiming the mechanism, so an unusable one fails rather than falling
  // through to git behind the repo's back.
  return hasWorktreeScript(workspacePath)
    ? await fromScript(workspacePath)
    : await fromGit(workspacePath)
}

// The whole mechanism when it exists. A session's invocation is bare: no
// arguments and neither worktree variable, so the script picks the location,
// the branch and the base. Everything else is the script's business.
async function fromScript(workspacePath: string): Promise<WorktreeCreation> {
  const ran = await runWorktreeScript(workspacePath)
  if (!ran.ok) return { ok: false, output: ran.output }

  const branch = await branchOf(ran.path)
  return branch === undefined ? { ok: true, path: ran.path } : { ok: true, path: ran.path, branch }
}

// Plain git on a throwaway branch from the checkout's HEAD. The name is
// nobody's policy: when the work is ready the session's agent renames it.
async function fromGit(workspacePath: string): Promise<WorktreeCreation> {
  const root = join(workspacePath, WORKTREES)
  try {
    selfIgnoring(root)
  } catch (cause) {
    return {
      ok: false,
      output: `${WORKTREES} could not be prepared\n${cause instanceof Error ? cause.message : String(cause)}\n`
    }
  }

  const id = await mint(workspacePath, root)
  const path = join(root, id)
  const branch = `crucible/${id}`
  const ran = await capture(
    'git',
    ['-C', workspacePath, 'worktree', 'add', '-b', branch, path],
    { cwd: workspacePath }
  )
  if (ran.code !== 0) {
    return { ok: false, output: `${headline('git worktree add', ran)}\n${ran.output}` }
  }

  // The fallback made a checkout; the repository's own script, when it has
  // one, makes it a place an agent can work. Only the fallback asks: the full
  // mechanism above is the whole mechanism, and calls this itself if it wants
  // it. A failure here leaves the worktree on disk, like every other failure.
  const setUp = await setUpWorktree(workspacePath, path)
  if (!setUp.ok) return { ok: false, output: setUp.output }

  return { ok: true, path, branch }
}

/** Written once per workspace, so an unprepared repo sees no untracked noise. */
function selfIgnoring(root: string): void {
  mkdirSync(root, { recursive: true })
  const ignore = join(root, '.gitignore')
  // A repository that wrote its own is left alone.
  if (existsSync(ignore)) return
  writeFileSync(ignore, IGNORE_EVERYTHING, 'utf8')
}

// Short, lowercase hex, and re-minted while it names a branch or a directory
// that is already there.
async function mint(workspacePath: string, root: string): Promise<string> {
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
    const id = randomBytes(3).toString('hex')
    if (existsSync(join(root, id))) continue
    const taken = await capture('git', [
      '-C',
      workspacePath,
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/crucible/${id}`
    ])
    if (taken.code !== 0) return id
  }
  // Twenty collisions in a row is not a state to invent a name for: let git
  // refuse the last one and show the user what it said.
  return randomBytes(3).toString('hex')
}
