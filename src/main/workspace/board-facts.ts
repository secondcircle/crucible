import type { BranchFact, ChecksFact, PullRequestFact } from '../../shared/workspace/classify-board'

// Everything that turns `git` and `gh` output into facts, and nothing that
// spawns either: the parsing is where the mistakes live, so it is pure and
// tested against captured output.

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

/**
 * One row per branch: the local head and the `origin/` ref of the same short
 * name are the same branch, and the copy with the later commit is the one the
 * board judges — the question is whether work was added after a merge, and
 * whichever copy is further along is the one that answers it.
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
 * The rollup holds check runs (a status and a conclusion) and status contexts
 * (a state). Nothing at all means the host reported nothing, which is not the
 * same as everything passing.
 */
function rollup(entries: readonly Record<string, unknown>[]): ChecksFact | undefined {
  if (entries.length === 0) return undefined
  let failed = 0
  let running = 0
  let passed = 0
  for (const entry of entries) {
    // A check run carries a status and, once it has one, a conclusion; a status
    // context carries a state instead.
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
