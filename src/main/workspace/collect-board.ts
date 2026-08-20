import {
  classifyBoard,
  type BoardFacts,
  type BranchFact,
  type PullRequestFact
} from '../../shared/workspace/classify-board'
import type { BranchBoardAnswer } from '../../shared/workspace/service'
import {
  dedupePullRequests,
  FIELD,
  isGitHubRemote,
  mergeBranches,
  mergedByHeadQuery,
  parseLeftRightCount,
  parseMergedByHead,
  parseNameWithOwner,
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

/**
 * Bounds the three lists of *open* pull requests one person is part of, which
 * is a human-sized number. Nothing about landing is read off a list like this:
 * merged records are asked for by branch (see `readMerged`), so no volume of
 * newer pull requests can push an old squash merge out of sight.
 */
const OPEN_PR_LIMIT = 100

/** How many branches one merged-record request asks about. */
const MERGED_BATCH = 50

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

  const host = isGitHubRemote(originUrl)
    ? await readHost(runner, workspacePath, branches, trunk.name, started, clock)
    : undefined

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

const UNREACHABLE: HostFacts = { reachable: false, pullRequests: [] }

type Gh = (...args: readonly string[]) => Promise<CommandOutcome>

/**
 * Everything gh knows, or nothing at all. A missing, unauthenticated or slow
 * gh leaves the board git-only and saying so, rather than half-populated.
 *
 * Three questions, exactly the three the board answers: which of your pull
 * requests are open, which open ones name you, and which of the branches in
 * front of you the host has already merged. The last is asked branch by
 * branch, so a landing is found however old its pull request is; the sweep is
 * bounded by this clone's branch count and batched, and if it cannot finish
 * inside the collection's budget the board says the host is unreachable rather
 * than filing a landed branch as stale.
 */
async function readHost(
  runner: CommandRunner,
  workspacePath: string,
  branches: readonly BranchFact[],
  trunk: string,
  started: number,
  clock: CollectionClock
): Promise<HostFacts> {
  const gh: Gh = async (...args) => {
    const left = started + COLLECTION_BUDGET_MS - clock.now()
    if (left <= 0) return { ok: false, stdout: '', stderr: 'out of time' }
    return runner('gh', args, { cwd: workspacePath, timeoutMs: Math.min(COMMAND_MS, left) })
  }

  try {
    return (await askHost(gh, branches, trunk)) ?? UNREACHABLE
  } catch {
    // gh answered something this build cannot read: git-only, and the board
    // says the host is unreachable rather than inventing pull requests.
    return UNREACHABLE
  }
}

/** Undefined where any one question went unanswered: it is all of it or none. */
async function askHost(
  gh: Gh,
  branches: readonly BranchFact[],
  trunk: string
): Promise<HostFacts | undefined> {
  const identity = await gh('api', 'user', '--jq', '.login')
  const login = identity.ok ? identity.stdout.trim() : ''
  if (login === '') return undefined

  const named = await gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner')
  const repo = named.ok ? parseNameWithOwner(named.stdout) : undefined
  if (repo === undefined) return undefined

  const open = await readOpen(gh, login)
  if (open === undefined) return undefined

  // A branch whose pull request is open right now needs no merged record: it is
  // in flight, and a merge that moved its tip is what keeps it out of Landed
  // anyway.
  const answered = new Set(open.map((pr) => pr.headRef))
  const unanswered = branches
    .map((branch) => branch.name)
    .filter((name) => name !== trunk && !answered.has(name))

  const merged = await readMerged(gh, repo, unanswered)
  if (merged === undefined) return undefined

  return {
    reachable: true,
    repoLabel: `${repo.owner}/${repo.name}`,
    login,
    pullRequests: [...open, ...merged]
  }
}

/** Your open pull requests, and the open ones that name you. */
async function readOpen(gh: Gh, login: string): Promise<readonly PullRequestFact[] | undefined> {
  const lists: PullRequestFact[] = []
  for (const question of [
    ['--author', login],
    // Requested reviewer and assignee are two questions to the host, and the
    // same pull request may answer both.
    ['--search', `review-requested:${login}`],
    ['--assignee', login]
  ]) {
    const answer = await gh(
      'pr',
      'list',
      '--state',
      'open',
      ...question,
      '--limit',
      String(OPEN_PR_LIMIT),
      '--json',
      PR_FIELDS
    )
    if (!answer.ok) return undefined
    lists.push(...parsePullRequests(answer.stdout))
  }
  return dedupePullRequests(lists)
}

/** The host's merged record for named branches, however old the merge is. */
async function readMerged(
  gh: Gh,
  repo: { readonly owner: string; readonly name: string },
  branches: readonly string[]
): Promise<readonly PullRequestFact[] | undefined> {
  const merged: PullRequestFact[] = []
  for (let from = 0; from < branches.length; from += MERGED_BATCH) {
    const batch = branches.slice(from, from + MERGED_BATCH)
    const answer = await gh(
      'api',
      'graphql',
      '-f',
      `query=${mergedByHeadQuery(repo.owner, repo.name, batch)}`
    )
    if (!answer.ok) return undefined
    merged.push(...parseMergedByHead(answer.stdout))
  }
  return merged
}
