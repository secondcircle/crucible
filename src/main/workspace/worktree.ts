import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { access, constants } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { WorktreeCreation } from '../../shared/workspace/service'

// Creating a worktree is a process, so it lives behind the workspace service
// with the rest of the OS facts. Two mechanisms and no third: the repo's own
// script when it has one, plain git when it does not. Nothing here removes a
// worktree, a branch or a directory, under any outcome.

/** What a repository claims the mechanism by placing there. */
const SCRIPT = join('.crucible', 'worktree')

/** Where the fallback puts what it makes, and what it ignores itself with. */
const WORKTREES = join('.crucible', 'worktrees')

const IGNORE_EVERYTHING = '*\n'

/** Room enough that a collision is a curiosity rather than a wait. */
const MINT_ATTEMPTS = 20

export async function isGitWorkspace(workspacePath: string): Promise<boolean> {
  const ran = await run('git', ['-C', workspacePath, 'rev-parse', '--is-inside-work-tree'])
  return ran.code === 0 && ran.stdout.trim() === 'true'
}

export async function createWorktree(workspacePath: string): Promise<WorktreeCreation> {
  const script = join(workspacePath, SCRIPT)
  // Presence decides, not executability: the file's existence is the repo
  // claiming the mechanism, so an unusable one fails rather than falling
  // through to git behind the repo's back.
  return existsSync(script)
    ? await fromScript(workspacePath, script)
    : await fromGit(workspacePath)
}

// The whole mechanism when it exists: run from the checkout, no arguments, no
// Crucible-specific environment. Everything else is the script's business.
async function fromScript(workspacePath: string, script: string): Promise<WorktreeCreation> {
  try {
    await access(script, constants.X_OK)
  } catch {
    return {
      ok: false,
      output: `${SCRIPT} is not executable\nchmod +x ${SCRIPT}\n`
    }
  }

  const ran = await run(script, [], workspacePath)
  if (ran.code !== 0) return { ok: false, output: `${headline(SCRIPT, ran)}\n${ran.output}` }

  const reported = lastLine(ran.stdout)
  if (reported === undefined) {
    return {
      ok: false,
      output: `${SCRIPT} exited 0 without reporting a worktree path\n${ran.output}`
    }
  }
  if (!isAbsolute(reported) || !directoryExists(reported)) {
    return {
      ok: false,
      output: `${SCRIPT} reported a path that is not a worktree: ${reported}\n${ran.output}`
    }
  }

  const branch = await branchOf(reported)
  return branch === undefined ? { ok: true, path: reported } : { ok: true, path: reported, branch }
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
  const ran = await run(
    'git',
    ['-C', workspacePath, 'worktree', 'add', '-b', branch, path],
    workspacePath
  )
  if (ran.code !== 0) {
    return { ok: false, output: `${headline('git worktree add', ran)}\n${ran.output}` }
  }
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
    const taken = await run('git', [
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

/** Empty or unreadable leaves the branch unknown, which the chip can say. */
async function branchOf(path: string): Promise<string | undefined> {
  const ran = await run('git', ['-C', path, 'branch', '--show-current'])
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

/** The last non-empty line, trimmed: the contract's one piece of parsing. */
function lastLine(stdout: string): string | undefined {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return lines.at(-1)
}

interface Ran {
  /** The process's own status, or absent when it never got to exit. */
  readonly code?: number
  readonly signal?: string
  /** stdout alone, which is where the contract's path is. */
  readonly stdout: string
  /** stdout and stderr interleaved, as a person watching would have seen. */
  readonly output: string
}

function headline(what: string, ran: Ran): string {
  if (ran.signal !== undefined) return `${what} was killed by ${ran.signal}`
  if (ran.code === undefined) return `${what} could not be run`
  return `${what} exited ${ran.code}`
}

// No timeout and no kill: the script owns how long it takes, and a run that
// never ends is the repository's own problem to see.
function run(command: string, args: readonly string[], cwd?: string): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...(cwd === undefined ? {} : { cwd }),
      stdio: ['ignore', 'pipe', 'pipe']
    })
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
    function settle(ran: Ran): void {
      if (settled) return
      settled = true
      resolve(ran)
    }

    child.on('error', (cause: Error) => {
      settle({ stdout, output: `${output}${cause.message}\n` })
    })
    child.on('close', (code, signal) => {
      settle({
        stdout,
        output,
        ...(signal === null ? {} : { signal }),
        ...(code === null ? {} : { code })
      })
    })
  })
}
