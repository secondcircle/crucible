import type { BranchFact, ChecksFact, PullRequestFact } from '../../shared/workspace/classify-board'

// Nothing here spawns `git` or `gh`: the parsing is where the mistakes live,
// so it stays pure and drivable from captured output.

/** The field separator the collector asks `for-each-ref` to use. */
export const FIELD = '\t'

export interface RefFact {
  /** The full ref, e.g. `refs/heads/main` or `refs/remotes/origin/main`. */
  readonly ref: string
  readonly tip: string
  readonly authorEmail: string
  readonly touchedAt: string
  /** Absent where git could not count them and rev-list has to. */
  readonly ahead?: number
  readonly behind?: number
  readonly subject: string
}

/**
 * `%(refname) %(objectname) %(authoremail) %(committerdate:iso-strict)
 * %(ahead-behind:<trunk>) %(contents:subject)`, tab separated.
 */
export function parseRefs(stdout: string): readonly RefFact[] {
  const facts: RefFact[] = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    const [ref, tip, authorEmail, touchedAt, aheadBehind, ...rest] = line.split(FIELD)
    if (ref === undefined || tip === undefined) continue
    const counts = parseAheadBehind(aheadBehind ?? '')
    facts.push({
      ref,
      tip,
      // git writes it in angle brackets, which no one wants to read.
      authorEmail: (authorEmail ?? '').replace(/^<|>$/g, ''),
      touchedAt: touchedAt ?? '',
      ...(counts === undefined ? {} : counts),
      // A subject can hold anything; only the fields before it are positional.
      subject: rest.join(FIELD)
    })
  }
  return facts
}

/** `%(ahead-behind:…)` answers "<ahead> <behind>", and nothing when it cannot. */
export function parseAheadBehind(
  field: string
): { readonly ahead: number; readonly behind: number } | undefined {
  const [ahead, behind] = field.trim().split(/\s+/)
  if (ahead === undefined || behind === undefined) return undefined
  const counted = { ahead: Number(ahead), behind: Number(behind) }
  if (Number.isNaN(counted.ahead) || Number.isNaN(counted.behind)) return undefined
  return counted
}

/** `git rev-list --left-right --count trunk...branch`: behind, then ahead. */
export function parseLeftRightCount(
  stdout: string
): { readonly ahead: number; readonly behind: number } | undefined {
  const [behind, ahead] = stdout.trim().split(/\s+/)
  if (ahead === undefined || behind === undefined) return undefined
  const counted = { ahead: Number(ahead), behind: Number(behind) }
  if (Number.isNaN(counted.ahead) || Number.isNaN(counted.behind)) return undefined
  return counted
}

/** `refs/remotes/origin/main` is how origin/HEAD names the trunk. */
export function parseTrunkRef(stdout: string): string | undefined {
  const ref = stdout.trim()
  const name = ref.startsWith('refs/remotes/origin/') ? ref.slice('refs/remotes/origin/'.length) : ''
  return name === '' || name === 'HEAD' ? undefined : name
}

export function isGitHubRemote(originUrl: string): boolean {
  return /(^|[@/.])github\.com[:/]/.test(originUrl.trim())
}

/** `owner/name`, which is both the board's label and what a query names. */
export function parseNameWithOwner(
  stdout: string
): { readonly owner: string; readonly name: string } | undefined {
  const [owner, name, ...rest] = stdout.trim().split('/')
  if (owner === undefined || name === undefined || rest.length > 0) return undefined
  if (owner === '' || name === '') return undefined
  return { owner, name }
}

/**
 * A local head and the `origin/` ref of one short name are the same branch, and
 * the later commit judges it: only the copy further along can show work added
 * after a merge.
 */
export function mergeBranches(
  refs: readonly RefFact[],
  where: { readonly checkedOut?: string }
): readonly BranchFact[] {
  const byName = new Map<string, { local?: RefFact; origin?: RefFact }>()

  for (const ref of refs) {
    const local = ref.ref.startsWith('refs/heads/')
    const name = local
      ? ref.ref.slice('refs/heads/'.length)
      : ref.ref.startsWith('refs/remotes/origin/')
        ? ref.ref.slice('refs/remotes/origin/'.length)
        : undefined
    // origin/HEAD is a pointer at the trunk, not a branch of anybody's.
    if (name === undefined || name === '' || name === 'HEAD') continue
    const entry = byName.get(name) ?? {}
    byName.set(name, local ? { ...entry, local: ref } : { ...entry, origin: ref })
  }

  const branches: BranchFact[] = []
  for (const [name, { local, origin }] of byName) {
    const tipRef = pickTip(local, origin)
    if (tipRef === undefined) continue
    branches.push({
      name,
      tip: tipRef.tip,
      local: local !== undefined,
      onOrigin: origin !== undefined,
      checkedOut: where.checkedOut === name,
      subject: tipRef.subject,
      authorEmail: tipRef.authorEmail,
      touchedAt: tipRef.touchedAt,
      ahead: tipRef.ahead ?? 0,
      behind: tipRef.behind ?? 0
    })
  }
  return branches
}

function pickTip(local: RefFact | undefined, origin: RefFact | undefined): RefFact | undefined {
  if (local === undefined) return origin
  if (origin === undefined) return local
  if (local.tip === origin.tip) return local
  return time(origin.touchedAt) > time(local.touchedAt) ? origin : local
}

function time(iso: string): number {
  const at = new Date(iso).getTime()
  return Number.isNaN(at) ? 0 : at
}

/** The fields the collector asks `gh pr list --json` for. */
export const PR_FIELDS = [
  'number',
  'state',
  'isDraft',
  'headRefName',
  'headRefOid',
  'title',
  'url',
  'updatedAt',
  'author',
  'mergedBy',
  'statusCheckRollup',
  'reviewDecision',
  'reviewRequests',
  'assignees'
].join(',')

interface RawPullRequest {
  number?: number
  state?: string
  isDraft?: boolean
  headRefName?: string
  headRefOid?: string
  title?: string
  url?: string
  updatedAt?: string
  author?: { login?: string } | null
  mergedBy?: { login?: string } | null
  statusCheckRollup?: readonly Record<string, unknown>[] | null
  reviewDecision?: string | null
  reviewRequests?: readonly Record<string, unknown>[] | null
  assignees?: readonly Record<string, unknown>[] | null
}

/** Throws on anything that is not gh's answer, which the collector treats as an unreachable host. */
export function parsePullRequests(stdout: string): readonly PullRequestFact[] {
  const parsed: unknown = JSON.parse(stdout)
  if (!Array.isArray(parsed)) throw new Error('gh answered something that is not a list.')

  const facts: PullRequestFact[] = []
  for (const raw of parsed as readonly RawPullRequest[]) {
    const number = raw.number
    const headRef = raw.headRefName
    if (typeof number !== 'number' || typeof headRef !== 'string') continue
    const checks = rollup(raw.statusCheckRollup ?? [])
    facts.push({
      number,
      state:
        raw.state === 'MERGED'
          ? 'merged'
          : raw.state === 'CLOSED'
            ? 'closed'
            : raw.isDraft === true
              ? 'draft'
              : 'open',
      url: raw.url ?? '',
      headRef,
      headTip: raw.headRefOid ?? '',
      title: raw.title ?? '',
      authorLogin: raw.author?.login ?? '',
      updatedAt: raw.updatedAt ?? '',
      ...(raw.mergedBy?.login === undefined ? {} : { mergedBy: raw.mergedBy.login }),
      ...(checks === undefined ? {} : { checks }),
      changesRequested: raw.reviewDecision === 'CHANGES_REQUESTED',
      reviewers: names(raw.reviewRequests ?? []),
      assignees: names(raw.assignees ?? [])
    })
  }
  return facts
}

/**
 * Asked by head ref rather than off a list of the newest N, so no volume of
 * newer pull requests can hide a branch squash-merged years ago.
 */
export function mergedByHeadQuery(
  owner: string,
  name: string,
  branches: readonly string[]
): string {
  const asked = branches
    .map(
      (branch, index) =>
        `    b${index}: pullRequests(headRefName: ${JSON.stringify(branch)}, ` +
        'states: [MERGED], first: 1, orderBy: {field: UPDATED_AT, direction: DESC}) ' +
        '{ nodes { ...F } }'
    )
    .join('\n')
  return (
    `query {\n  repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {\n` +
    `${asked}\n  }\n}\n` +
    'fragment F on PullRequest {\n' +
    '  number\n  url\n  title\n  updatedAt\n  headRefName\n  headRefOid\n' +
    '  author { login }\n  mergedBy { login }\n}'
  )
}

interface RawMergedPullRequest {
  number?: number
  url?: string
  title?: string
  updatedAt?: string
  headRefName?: string
  headRefOid?: string
  author?: { login?: string } | null
  mergedBy?: { login?: string } | null
}

/** Throws on anything that is not gh's answer, which the collector treats as an unreachable host. */
export function parseMergedByHead(stdout: string): readonly PullRequestFact[] {
  const parsed: unknown = JSON.parse(stdout)
  const repository = (parsed as { data?: { repository?: unknown } } | null)?.data?.repository
  if (repository === null || typeof repository !== 'object') {
    throw new Error('gh answered nothing about this repository.')
  }

  const facts: PullRequestFact[] = []
  for (const asked of Object.values(repository as Record<string, unknown>)) {
    const nodes = (asked as { nodes?: unknown } | null)?.nodes
    if (!Array.isArray(nodes)) continue
    for (const raw of nodes as readonly RawMergedPullRequest[]) {
      const number = raw.number
      const headRef = raw.headRefName
      if (typeof number !== 'number' || typeof headRef !== 'string') continue
      facts.push({
        number,
        state: 'merged',
        url: raw.url ?? '',
        headRef,
        headTip: raw.headRefOid ?? '',
        title: raw.title ?? '',
        authorLogin: raw.author?.login ?? '',
        updatedAt: raw.updatedAt ?? '',
        ...(raw.mergedBy?.login === undefined ? {} : { mergedBy: raw.mergedBy.login }),
        // Checks and reviews are the live pull requests' business; a merged one
        // is judged on its head commit and who merged it.
        changesRequested: false,
        reviewers: [],
        assignees: []
      })
    }
  }
  return facts
}

/** The same pull request can answer two questions; the board wants one of it. */
export function dedupePullRequests(
  facts: readonly PullRequestFact[]
): readonly PullRequestFact[] {
  const byNumber = new Map<number, PullRequestFact>()
  for (const fact of facts) if (!byNumber.has(fact.number)) byNumber.set(fact.number, fact)
  return [...byNumber.values()]
}

/** A requested reviewer is a person or a team, and a team has a slug. */
function names(entries: readonly Record<string, unknown>[]): readonly string[] {
  return entries.flatMap((entry) => {
    const login = entry.login ?? entry.slug ?? entry.name
    return typeof login === 'string' && login !== '' ? [login] : []
  })
}

const FAILED = new Set([
  'FAILURE',
  'ERROR',
  'TIMED_OUT',
  'CANCELLED',
  'STARTUP_FAILURE',
  'ACTION_REQUIRED'
])

const RUNNING = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED'])

/**
 * Check runs carry a status and a conclusion, status contexts a state, and an
 * empty rollup means the host reported nothing rather than everything passing.
 */
function rollup(entries: readonly Record<string, unknown>[]): ChecksFact | undefined {
  if (entries.length === 0) return undefined
  let failed = 0
  let running = 0
  let passed = 0
  for (const entry of entries) {
    const status = text(entry.status)
    const conclusion = text(entry.conclusion)
    const outcome = conclusion === '' ? text(entry.state) : conclusion
    if (FAILED.has(outcome)) failed += 1
    else if (RUNNING.has(outcome) || RUNNING.has(status)) running += 1
    // Skipped and neutral are not failures and are not still going: what is
    // left of the run is green.
    else if (outcome !== '') passed += 1
  }
  return { failed, running, passed }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
