import {
  classifyBoard,
  type BoardFacts,
  type BranchFact,
  type PullRequestFact
} from '../../shared/workspace/classify-board'
import type { BranchBoardAnswer } from '../../shared/workspace/service'
import {
  FIELD,
  isGitHubRemote,
  mergeBranches,
  parseLeftRightCount,
  parsePullRequests,
  parseRefs,
  parseTrunkRef,
  PR_FIELDS
} from './board-facts'

// The collector: which commands are run, in which order, and what is done with
// what they say. The commands themselves arrive as a runner, so this whole
// path is drivable from captured output and `npm test` spawns nothing.

/** A collection that cannot finish inside this fails rather than hanging. */
export const COLLECTION_BUDGET_MS = 30_000

/** How long any single command may take. */
const COMMAND_MS = 15_000

/** More pull requests than a person has any use for on one board. */
const PR_LIMIT = 100

export interface CommandOutcome {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number }
) => Promise<CommandOutcome>

export interface CollectionClock {
  /** Epoch milliseconds; the collection's own "now". */
  now(): number
}

/**
 * Collects and classifies one workspace's board. The only write it performs is
 * `git fetch --prune origin`, which touches remote-tracking refs and nothing
 * else — never the working tree, the index, or any local branch.
 */
export async function collectBoard(
  runner: CommandRunner,
  workspacePath: string,
  clock: CollectionClock = { now: () => Date.now() }
): Promise<BranchBoardAnswer> {
  const started = clock.now()

  async function git(...args: readonly string[]): Promise<CommandOutcome> {
    const left = started + COLLECTION_BUDGET_MS - clock.now()
    if (left <= 0) {
      throw new Error('Reading this repository took too long, so Crucible stopped.')
    }
    return runner('git', args, { cwd: workspacePath, timeoutMs: Math.min(COMMAND_MS, left) })
  }

  const repository = await git('rev-parse', '--show-toplevel')
  // Not a git repository: a normal answer, and how the renderer learns to show
  // no chip and no board for this workspace.
  if (!repository.ok) return { kind: 'noRepository' }

  const email = await git('config', '--get', 'user.email')
  const origin = await git('remote', 'get-url', 'origin')
  const originUrl = origin.ok ? origin.stdout.trim() : ''

  if (originUrl !== '') {
    // So ahead/behind and remote presence are told against reality rather than
    // against a stale ref. Offline, it simply fails and the refs on hand stand.
    await git('fetch', '--prune', 'origin')
  }

  const trunk = await findTrunk(git, originUrl !== '')
  if (trunk === undefined) {
    throw new Error(
      'Crucible could not tell which branch is the trunk here — no origin/HEAD, main or master.'
    )
  }

  const head = await git('symbolic-ref', '--quiet', '--short', 'HEAD')
  const checkedOut = head.ok ? head.stdout.trim() : ''

  const branches = await readBranches(git, trunk.ref, checkedOut)

  const host = isGitHubRemote(originUrl) ? await readHost(runner, workspacePath, started, clock) : undefined

  const facts: BoardFacts = {
    trunk: trunk.name,
    repoLabel: host?.repoLabel ?? workspacePath,
    ...(email.ok && email.stdout.trim() !== '' ? { userEmail: email.stdout.trim() } : {}),
    ...(host?.login === undefined ? {} : { login: host.login }),
    ...(host === undefined ? {} : { host: { kind: 'github' as const, reachable: host.reachable } }),
    branches,
    pullRequests: host?.pullRequests ?? []
  }

  return { kind: 'board', board: classifyBoard(facts, clock.now()) }
}

type Git = (...args: readonly string[]) => Promise<CommandOutcome>

/** The remote default branch, then a local main, then a local master. */
async function findTrunk(
  git: Git,
  hasOrigin: boolean
): Promise<{ readonly name: string; readonly ref: string } | undefined> {
  if (hasOrigin) {
    const pointer = await git('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD')
    const name = pointer.ok ? parseTrunkRef(pointer.stdout) : undefined
    if (name !== undefined) return { name, ref: `refs/remotes/origin/${name}` }
  }
  for (const name of ['main', 'master']) {
    const local = await git('show-ref', '--verify', '--quiet', `refs/heads/${name}`)
    if (local.ok) return { name, ref: `refs/heads/${name}` }
  }
  return undefined
}

const REF_FIELDS = [
  '%(refname)',
  '%(objectname)',
  '%(authoremail)',
  '%(committerdate:iso-strict)'
].join(FIELD)

async function readBranches(
  git: Git,
  trunkRef: string,
  checkedOut: string
): Promise<readonly BranchFact[]> {
  const counted = await git(
    'for-each-ref',
    `--format=${REF_FIELDS}${FIELD}%(ahead-behind:${trunkRef})${FIELD}%(contents:subject)`,
    'refs/heads',
    'refs/remotes/origin'
  )
  if (counted.ok) {
    return mergeBranches(parseRefs(counted.stdout), { checkedOut })
  }

  // Git before 2.41 has no ahead-behind field and refuses the whole format, so
  // the counts are asked for one branch at a time instead.
  const plain = await git(
    'for-each-ref',
    `--format=${REF_FIELDS}${FIELD}${FIELD}%(contents:subject)`,
    'refs/heads',
    'refs/remotes/origin'
  )
  if (!plain.ok) {
    throw new Error('Crucible could not read this repository\u2019s branches.')
  }
  const branches = mergeBranches(parseRefs(plain.stdout), { checkedOut })

  const withCounts: BranchFact[] = []
  for (const branch of branches) {
    const range = await git('rev-list', '--left-right', '--count', `${trunkRef}...${branch.tip}`)
    const counts = range.ok ? parseLeftRightCount(range.stdout) : undefined
    withCounts.push(counts === undefined ? branch : { ...branch, ...counts })
  }
  return withCounts
}

interface HostFacts {
  readonly reachable: boolean
  readonly repoLabel?: string
  readonly login?: string
  readonly pullRequests: readonly PullRequestFact[]
}

/**
 * Everything gh knows, or nothing at all. A missing, unauthenticated or slow
 * gh leaves the board git-only and saying so, rather than half-populated.
 */
async function readHost(
  runner: CommandRunner,
  workspacePath: string,
  started: number,
  clock: CollectionClock
): Promise<HostFacts> {
  async function gh(...args: readonly string[]): Promise<CommandOutcome> {
    const left = started + COLLECTION_BUDGET_MS - clock.now()
    if (left <= 0) return { ok: false, stdout: '', stderr: 'out of time' }
    return runner('gh', args, { cwd: workspacePath, timeoutMs: Math.min(COMMAND_MS, left) })
  }

  const unreachable: HostFacts = { reachable: false, pullRequests: [] }

  const login = await gh('api', 'user', '--jq', '.login')
  if (!login.ok || login.stdout.trim() === '') return unreachable

  const repo = await gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner')
  if (!repo.ok || repo.stdout.trim() === '') return unreachable

  const list = await gh(
    'pr',
    'list',
    '--state',
    'all',
    '--limit',
    String(PR_LIMIT),
    '--json',
    PR_FIELDS
  )
  if (!list.ok) return unreachable

  try {
    return {
      reachable: true,
      repoLabel: repo.stdout.trim(),
      login: login.stdout.trim(),
      pullRequests: parsePullRequests(list.stdout)
    }
  } catch {
    // gh answered something this build cannot read: git-only, and the board
    // says the host is unreachable rather than inventing pull requests.
    return unreachable
  }
}
