import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { FileStatus, FileTree } from '../../shared/workspace/service'

// Kept apart from the service so the walk and the ignore rules can be tested
// against a temp folder, with no process or event stream in the way.

/** Never listed, never walked into, in a git workspace or outside one. */
const ALWAYS_SKIPPED = '.git'

/** A folder this big is a mistake to walk, not a workspace to search. */
const WALK_LIMIT = 20_000

/** Workspace-relative and `/`-separated, whichever of the two paths answers. */
export async function listFiles(workspacePath: string): Promise<readonly string[]> {
  const tracked = await gitFiles(workspacePath)
  return tracked ?? (await walk(workspacePath))
}

// What the file tree lists: the same entries the search sees, plus how git
// sees each of them. A folder outside a repository reports no changes at all,
// which is what leaves its rows plain.
export async function fileTree(directory: string): Promise<FileTree> {
  const [paths, status] = await Promise.all([listFiles(directory), gitStatus(directory)])
  // The listing is what the disk has; git's record of a path the listing does
  // not name is a file git still remembers and the disk has lost. Coloring
  // follows the rows, so no folder wears a dot for a row nobody can see.
  const listed = new Set(paths)
  const changed = Object.fromEntries(Object.entries(status).filter(([path]) => listed.has(path)))
  return { directory, paths, changed }
}

// `-c` cached, `-o` untracked, `--exclude-standard` the ignore rules git itself
// would apply: what a person expects to see. Minus `--deleted`, because the
// index keeps a tracked file after it is gone from disk and a listing of the
// index is not a listing of the folder: the phantom rows error on a click,
// and an agent deleting and renaming files makes them all day.
async function gitFiles(workspacePath: string): Promise<readonly string[] | undefined> {
  const [out, missing] = await Promise.all([
    git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], workspacePath),
    git(['ls-files', '--deleted', '-z'], workspacePath)
  ])
  // Not a repository, or no git at all: the walk answers instead.
  if (out === undefined) return undefined
  const gone = new Set(split(missing ?? ''))
  return split(out)
    .filter((path) => !gone.has(path) && !path.startsWith(`${ALWAYS_SKIPPED}/`))
    .sort()
}

/** The paths in one `-z` answer; both commands name them from the same cwd. */
function split(out: string): readonly string[] {
  return out.split('\0').filter((path) => path !== '')
}

// Every changed file under the directory, by the same relative path the
// listing uses. Porcelain paths are the repository's, so the directory's own
// prefix comes off them and anything outside it is not this tree's business.
async function gitStatus(directory: string): Promise<Readonly<Record<string, FileStatus>>> {
  const prefix = await git(['rev-parse', '--show-prefix'], directory)
  if (prefix === undefined) return {}
  const out = await git(
    ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames', '--', '.'],
    directory
  )
  if (out === undefined) return {}

  const under = prefix.trim()
  const changed: Record<string, FileStatus> = {}
  for (const record of out.split('\0')) {
    // `XY path`: two status letters, a space, then the path.
    if (record.length < 4) continue
    const path = record.slice(3)
    if (!path.startsWith(under)) continue
    changed[path.slice(under.length)] = record.startsWith('?') ? 'untracked' : 'modified'
  }
  return changed
}

/** stdout on a clean exit; `undefined` for no git, no repository, any refusal. */
function git(args: readonly string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn('git', [...args], { cwd })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    child.on('error', () => resolve(undefined))
    child.on('close', (code) => resolve(code === 0 ? out : undefined))
  })
}

interface IgnoreRule {
  /** Matched against the path relative to the folder holding the .gitignore. */
  readonly test: RegExp
  readonly directoryOnly: boolean
  readonly negated: boolean
}

async function readIgnoreRules(folder: string): Promise<readonly IgnoreRule[]> {
  let text: string
  try {
    text = await readFile(join(folder, '.gitignore'), 'utf8')
  } catch {
    return []
  }

  const rules: IgnoreRule[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const negated = line.startsWith('!')
    let pattern = negated ? line.slice(1) : line
    const directoryOnly = pattern.endsWith('/')
    if (directoryOnly) pattern = pattern.slice(0, -1)
    if (pattern === '') continue
    rules.push({ test: toRegExp(pattern), directoryOnly, negated })
  }
  return rules
}

// The subset of git's syntax a workspace actually uses: `*`, `?`, a leading or
// inner `/` anchoring to the folder, and a bare name matching at any depth.
function toRegExp(pattern: string): RegExp {
  const anchored = pattern.includes('/')
  const cleaned = pattern.startsWith('/') ? pattern.slice(1) : pattern
  let source = ''
  for (const character of cleaned) {
    if (character === '*') source += '[^/]*'
    else if (character === '?') source += '[^/]'
    else source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  // An unanchored pattern matches a name at any depth, exactly as git says.
  return new RegExp(anchored ? `^${source}$` : `(^|/)${source}$`)
}

function ignored(
  rules: readonly { readonly folder: string; readonly rules: readonly IgnoreRule[] }[],
  path: string,
  isDirectory: boolean
): boolean {
  let decision = false
  for (const level of rules) {
    const scoped = level.folder === '' ? path : path.slice(level.folder.length + 1)
    for (const rule of level.rules) {
      if (rule.directoryOnly && !isDirectory) continue
      if (!rule.test.test(scoped)) continue
      decision = !rule.negated
    }
  }
  return decision
}

/**
 * Depth-first in alphabetical order, so the list is the same every time.
 *
 * Every read is awaited rather than synchronous: this is the answer to a
 * keystroke in an `@file` token, it runs in the main process, and a
 * 24,000-file workspace took 46-71 ms of held loop per character typed.
 * Exported so a test can hold it to that without a repository in the way.
 */
export async function walk(workspacePath: string): Promise<readonly string[]> {
  const found: string[] = []

  async function visit(
    folder: string,
    inherited: readonly { readonly folder: string; readonly rules: readonly IgnoreRule[] }[]
  ): Promise<void> {
    if (found.length >= WALK_LIMIT) return
    const relativeFolder = toPosix(relative(workspacePath, folder))
    const own = await readIgnoreRules(folder)
    const rules =
      own.length === 0 ? inherited : [...inherited, { folder: relativeFolder, rules: own }]

    let entries: Dirent[]
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch {
      // A folder that cannot be read is not a folder to guess about.
      return
    }

    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ALWAYS_SKIPPED) continue
      const full = join(folder, entry.name)
      const path = toPosix(relative(workspacePath, full))
      // Symlinked folders are not followed: a workspace is a folder, not a
      // graph.
      if (entry.isDirectory()) {
        if (ignored(rules, path, true)) continue
        await visit(full, rules)
        continue
      }
      if (!entry.isFile()) continue
      if (ignored(rules, path, false)) continue
      found.push(path)
    }
  }

  await visit(workspacePath, [])
  return found
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}
