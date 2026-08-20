import type {
  BoardDrift,
  BoardGroupId,
  BoardRow,
  BoardSignal,
  BranchBoardSnapshot
} from './service'

// The board's judgment, and the only place it is made: facts in, grouped rows
// out. Pure, so it can be tested directly and so no clock or process hides
// inside an answer — the "now" staleness is measured against is an argument.

/** Untouched longer than this, and never landed, is what stale means. */
export const STALE_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

/** What the collector gathered about one branch, git-side only. */
export interface BranchFact {
  /** Short name, with the local head and the origin ref already merged. */
  readonly name: string
  /** The tip commit, which is what a merged pull request is checked against. */
  readonly tip: string
  readonly local: boolean
  readonly onOrigin: boolean
  readonly checkedOut: boolean
  readonly subject: string
  /** The tip commit's author email, which is what "yours" is decided by. */
  readonly authorEmail: string
  /** ISO of the tip commit. */
  readonly touchedAt: string
  readonly ahead: number
  readonly behind: number
}

export interface ChecksFact {
  readonly failed: number
  readonly running: number
  readonly passed: number
}

/** One pull request as the host reports it. Empty list where none answered. */
export interface PullRequestFact {
  readonly number: number
  // Closed-but-unmerged is carried so the classifier can ignore it out loud
  // rather than the parser dropping it silently.
  readonly state: 'open' | 'draft' | 'merged' | 'closed'
  readonly url: string
  readonly headRef: string
  /** The head commit the host has for this pull request. */
  readonly headTip: string
  readonly title: string
  readonly authorLogin: string
  /** ISO of the last update, which is what a waiting row is dated by. */
  readonly updatedAt: string
  readonly mergedBy?: string
  readonly checks?: ChecksFact
  readonly changesRequested: boolean
  readonly reviewers: readonly string[]
  readonly assignees: readonly string[]
}

export interface BoardFacts {
  readonly trunk: string
  /** "owner/name" where a host answered; the workspace path where none. */
  readonly repoLabel: string
  /** This clone's configured `user.email`; absent when git has none. */
  readonly userEmail?: string
  /** The authenticated host login, where a host answered. */
  readonly login?: string
  readonly host?: { readonly kind: 'github'; readonly reachable: boolean }
  readonly branches: readonly BranchFact[]
  /** Empty where no host answered. */
  readonly pullRequests: readonly PullRequestFact[]
}

/** Board order, which is also the order the renderer draws the groups in. */
const GROUP_ORDER: readonly BoardGroupId[] = [
  'landed',
  'inFlight',
  'waitingOnYou',
  'localOnly',
  'stale'
]

export function classifyBoard(facts: BoardFacts, now: number): BranchBoardSnapshot {
  const hosted = facts.host?.reachable === true
  // A host that could not answer leaves no pull-request data at all, rather
  // than half of it: the board then says it is showing git only.
  const pullRequests = hosted ? facts.pullRequests : []
  const login = facts.login
  const staleBefore = now - STALE_DAYS * DAY_MS

  const waiting =
    login === undefined
      ? []
      : pullRequests.filter(
          (pr) =>
            (pr.state === 'open' || pr.state === 'draft') &&
            pr.authorLogin !== login &&
            (pr.reviewers.includes(login) || pr.assignees.includes(login))
        )
  // A waiting pull request owns its head ref: the branch files here and
  // nowhere else, even when this clone has a copy of it.
  const waitingRefs = new Set(waiting.map((pr) => pr.headRef))

  const rows: BoardRow[] = []

  for (const pr of waiting) {
    const branch = facts.branches.find((candidate) => candidate.name === pr.headRef)
    rows.push({
      group: 'waitingOnYou',
      name: pr.headRef,
      yours: false,
      checkedOut: branch?.checkedOut ?? false,
      local: branch?.local ?? false,
      onOrigin: branch?.onOrigin ?? false,
      subject: pr.title,
      drift: { kind: 'author', login: pr.authorLogin },
      touchedAt: pr.updatedAt,
      // Review wins where both apply: it is the thing only you can do.
      signal:
        login !== undefined && pr.reviewers.includes(login)
          ? { kind: 'yourReview' }
          : { kind: 'assignedToYou' },
      pr: { number: pr.number, state: pr.state === 'draft' ? 'draft' : 'open', url: pr.url }
    })
  }

  for (const branch of facts.branches) {
    // The trunk is the thing everything else is measured against, never a row.
    if (branch.name === facts.trunk) continue
    if (waitingRefs.has(branch.name)) continue
    rows.push(branchRow(branch, facts, pullRequests, staleBefore))
  }

  return {
    collectedAt: new Date(now).toISOString(),
    trunk: facts.trunk,
    repoLabel: facts.repoLabel,
    ...(facts.host === undefined ? {} : { host: facts.host }),
    rows: sortRows(rows)
  }
}

/** The chip's two numbers and the sidebar badge's one, computed in one place. */
export function boardCounts(board: BranchBoardSnapshot): {
  readonly landed: number
  readonly needYou: number
} {
  const landed = board.rows.filter((row) => row.group === 'landed' && row.yours).length
  // Exactly three signals count. Anything else on the board — assigned to you,
  // stale, local only — is listed and never counted, so the chip is not
  // permanently lit.
  const needYou = board.rows.filter(
    (row) =>
      (row.yours &&
        (row.signal?.kind === 'checksFailed' || row.signal?.kind === 'changesRequested')) ||
      row.signal?.kind === 'yourReview'
  ).length
  return { landed, needYou }
}

function branchRow(
  branch: BranchFact,
  facts: BoardFacts,
  pullRequests: readonly PullRequestFact[],
  staleBefore: number
): BoardRow {
  const merged = pullRequests.find(
    (pr) => pr.headRef === branch.name && pr.state === 'merged'
  )
  const open = pullRequests.find(
    (pr) => pr.headRef === branch.name && (pr.state === 'open' || pr.state === 'draft')
  )
  const counts: BoardDrift = { kind: 'counts', ahead: branch.ahead, behind: branch.behind }
  const yours =
    facts.userEmail !== undefined &&
    branch.authorEmail.toLowerCase() === facts.userEmail.toLowerCase()

  // The host's record wins where a host answered, because a squash merge
  // leaves no ancestry for git to find. A tip that moved past the merge point
  // keeps the branch out: that work is not in the trunk.
  const landedByHost = merged !== undefined && merged.headTip === branch.tip
  const landedByAncestry = branch.ahead === 0

  const shown = open ?? merged
  const pr =
    shown === undefined
      ? undefined
      : {
          number: shown.number,
          state:
            shown.state === 'merged'
              ? ('merged' as const)
              : shown.state === 'draft'
                ? ('draft' as const)
                : ('open' as const),
          url: shown.url
        }

  const common = {
    name: branch.name,
    yours,
    checkedOut: branch.checkedOut,
    local: branch.local,
    onOrigin: branch.onOrigin,
    subject: branch.subject,
    touchedAt: branch.touchedAt,
    ...(pr === undefined ? {} : { pr })
  }

  if (landedByHost || landedByAncestry) {
    const signal: BoardSignal = landedByHost
      ? { kind: 'merged', byYou: merged?.mergedBy !== undefined && merged.mergedBy === facts.login }
      : { kind: 'inTrunkHistory' }
    return {
      ...common,
      group: 'landed',
      // Squashed is what a landing with no ancestry looks like; an ancestry
      // landing says "0 ahead", which is the fact it was judged on.
      drift: landedByAncestry ? counts : { kind: 'squashed' },
      signal
    }
  }

  const stale = at(branch.touchedAt) < staleBefore
  // An open pull request is in flight at any age; only pull-request-less
  // branches can go stale. What is left is pushed (in flight) or never pushed
  // (local only).
  const group: BoardGroupId =
    open !== undefined ? 'inFlight' : stale ? 'stale' : branch.onOrigin ? 'inFlight' : 'localOnly'

  const signal = open === undefined ? undefined : liveSignal(open)

  return {
    ...common,
    group,
    drift: counts,
    ...(signal === undefined ? {} : { signal })
  }
}

/** One signal per row, first match wins. */
function liveSignal(pr: PullRequestFact): BoardSignal | undefined {
  if (pr.changesRequested) return { kind: 'changesRequested' }
  const checks = pr.checks
  if (checks === undefined) return undefined
  if (checks.failed > 0) return { kind: 'checksFailed', count: checks.failed }
  if (checks.running > 0) return { kind: 'checksRunning' }
  if (checks.passed > 0) return { kind: 'checksPassed' }
  return undefined
}

/** Group order, and most recently touched first inside each group. */
function sortRows(rows: readonly BoardRow[]): readonly BoardRow[] {
  return [...rows].sort((left, right) => {
    const byGroup = GROUP_ORDER.indexOf(left.group) - GROUP_ORDER.indexOf(right.group)
    if (byGroup !== 0) return byGroup
    // Parsed rather than compared as text: an ISO time carries an offset, and
    // two offsets do not sort as strings.
    return at(right.touchedAt) - at(left.touchedAt)
  })
}

function at(iso: string): number {
  const time = new Date(iso).getTime()
  return Number.isNaN(time) ? 0 : time
}
