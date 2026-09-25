import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, sep } from 'node:path'
import type { TargetDeclaration } from './authoring'
import { capture } from '../workspace/capture'

// Where a run works: its target repository, settled once at kickoff from what
// the kickoff named, what the workflow declares and, for a chained successor,
// where its predecessor worked. Every way that can go wrong is a refusal
// here, before a worktree exists or a node has cost anything; nothing is ever
// picked silently.

/** A run's target repository, as settled at kickoff. */
export interface TargetRepository {
  // As named inside the workspace folder and normalized (`x`, never `./x/`),
  // which is what the run record keeps. Absent is the workspace's own
  // repository.
  readonly named?: string
  /** The repository's top: where its scripts are read and its worktrees made. */
  readonly path: string
}

/** What asked for the target: a kickoff, or a predecessor's clean completion. */
export type TargetAsk =
  | { readonly by: 'kickoff'; readonly named?: string }
  // The predecessor's own target, as its record names it; absent is the
  // workspace's repository. Its branch exists only there.
  | { readonly by: 'chain'; readonly named?: string }

export interface SettleTargetRequest {
  /** The workspace folder the run belongs to. */
  readonly workspacePath: string
  /** The workflow's resolved name, for the refusals that are about it. */
  readonly workflow: string
  readonly declared?: TargetDeclaration
  readonly ask: TargetAsk
}

export async function settleTarget(request: SettleTargetRequest): Promise<TargetRepository> {
  const { workspacePath, workflow, declared, ask } = request
  const fixed =
    typeof declared === 'string' ? await checkedTarget(workspacePath, declared) : undefined
  const required = typeof declared === 'object'
  // `'.'` fixes nothing: it is the workspace's own repository, which is what
  // declaring nothing already means.
  const fixes = fixed !== undefined && fixed.named !== undefined ? fixed : undefined
  const asked =
    ask.named === undefined ? undefined : await checkedTarget(workspacePath, ask.named)
  const namesOne = asked !== undefined && asked.named !== undefined

  if (ask.by === 'chain') {
    const continuing = asked ?? { path: workspacePath }
    if (fixes !== undefined && !(await sameRepository(fixes, continuing))) {
      throw new Error(
        `The workflow "${workflow}" works in the target repository "${fixes.named}", but a ` +
          `chained successor continues in its predecessor's (${nameOf(continuing)}), the ` +
          'only repository its branch exists in.'
      )
    }
    if (required && !namesOne) {
      throw new Error(
        `The workflow "${workflow}" requires a target repository, but a chained successor ` +
          `continues in its predecessor's, which is ${nameOf(continuing)}.`
      )
    }
    return continuing
  }

  if (fixes !== undefined) {
    if (namesOne && !(await sameRepository(fixes, asked))) {
      throw new Error(
        `The workflow "${workflow}" works in the target repository "${fixes.named}", and this ` +
          `kickoff named "${asked.named}". Name "${fixes.named}" or no target at all.`
      )
    }
    return fixes
  }
  if (required && !namesOne) {
    throw new Error(
      `The workflow "${workflow}" requires a target repository, and none was named. Name one ` +
        `with \`target\`: a git repository inside the workspace folder ${workspacePath}, as a ` +
        'path relative to it.'
    )
  }
  return asked ?? { path: workspacePath }
}

/**
 * One named target, normalized and checked on disk: the top of a git
 * repository inside the workspace folder. It may sit at any depth, and a
 * submodule's top counts; a plain folder of some repository does not.
 */
async function checkedTarget(workspacePath: string, given: string): Promise<TargetRepository> {
  const named = normalizeTarget(workspacePath, given)
  if (named === undefined) return { path: workspacePath }
  const path = join(workspacePath, named)

  let folder: boolean
  try {
    folder = (await stat(path)).isDirectory()
  } catch {
    throw new Error(`The target repository "${given}" does not exist: nothing is at ${path}.`)
  }
  if (!folder) throw new Error(`The target repository "${given}" is not a folder: ${path}.`)

  const top = await capture('git', ['-C', path, 'rev-parse', '--show-toplevel'])
  if (top.code !== 0) {
    throw new Error(
      `The target repository "${given}" is not a git repository: no repository holds ${path}.`
    )
  }
  const topPath = top.stdout.trim()
  const [real, realTop, realWorkspace] = await Promise.all([
    realpath(path),
    realpath(topPath),
    realpath(workspacePath)
  ])
  if (real !== realTop) {
    throw new Error(
      `The target repository "${given}" is not the top of a git repository: ${path} is a ` +
        `folder inside the repository at ${topPath}.`
    )
  }
  // A spelling that lands on the workspace itself is the workspace's own
  // repository, the same as naming none.
  if (real === realWorkspace) return { path: workspacePath }
  return { named, path }
}

/**
 * The target as the record keeps it: relative, normalized, without a trailing
 * separator. Undefined for any spelling of the workspace folder itself.
 */
function normalizeTarget(workspacePath: string, given: string): string | undefined {
  const trimmed = given.trim()
  const outside = new Error(
    `The target repository "${given}" is not inside the workspace folder ${workspacePath}: ` +
      'a target is named as a path relative to that folder.'
  )
  if (isAbsolute(trimmed)) throw outside
  const normalized = normalize(trimmed === '' ? '.' : trimmed).replace(/[\\/]+$/, '')
  if (normalized === '.' || normalized === '') return undefined
  if (normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.startsWith('../')) {
    throw outside
  }
  return normalized
}

async function sameRepository(one: TargetRepository, other: TargetRepository): Promise<boolean> {
  if (one.path === other.path) return true
  const [left, right] = await Promise.all([realpath(one.path), realpath(other.path)])
  return left === right
}

function nameOf(target: TargetRepository): string {
  return target.named === undefined ? "the workspace's own repository" : `"${target.named}"`
}

/** Where a recorded target lives on disk; the workspace itself when none was recorded. */
export function targetPath(run: {
  readonly workspacePath: string
  readonly targetRepository?: string
}): string {
  return run.targetRepository === undefined
    ? run.workspacePath
    : join(run.workspacePath, run.targetRepository)
}
