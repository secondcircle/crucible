import type { IssueBoardSnapshot, IssueGroupId, IssueRow } from './service'

// The issue board's judgment, and the only place it is made. Pure: the clock
// arrives as an argument, so no answer can hide one.

/** One issue as the host reports it, before this board has judged it. */
export interface IssueFact {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly body: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly authorLogin: string
  readonly assignees: readonly string[]
  readonly labels: readonly { readonly name: string; readonly color?: string }[]
  readonly comments: number
  readonly latestComment?: { readonly login: string; readonly at: string; readonly body: string }
  // Open pull requests that cross-reference this issue, newest last. Only the
  // first one is shown; the rest are what makes it picked up all the same.
  readonly pullRequests: readonly {
    readonly number: number
    readonly state: 'open' | 'draft'
    readonly url: string
  }[]
}

export interface IssueFacts {
  /** "owner/name" as the host names the repository. */
  readonly repoLabel: string
  readonly login: string
  readonly issues: readonly IssueFact[]
  /** Numbers the host says mention you, which is a question of its own. */
  readonly mentioned: readonly number[]
}

/** Board order, which is also the order the renderer draws the groups in. */
const GROUP_ORDER: readonly IssueGroupId[] = [
  'assignedToYou',
  'mentionsYou',
  'unclaimed',
  'pickedUp',
  'assignedToOthers'
]

export function classifyIssues(facts: IssueFacts, now: number): IssueBoardSnapshot {
  const mentioned = new Set(facts.mentioned)
  // The repository's own name, not owner/name: it is what a person writing the
  // reference by hand would type, and gh reads it back.
  const repo = facts.repoLabel.split('/').at(-1) ?? facts.repoLabel

  const rows = facts.issues.map((issue): IssueRow => {
    const pr = issue.pullRequests[0]
    return {
      group: group(issue, facts.login, mentioned),
      number: issue.number,
      reference: `${repo}#${issue.number}`,
      title: issue.title,
      url: issue.url,
      labels: issue.labels,
      assignees: issue.assignees,
      authorLogin: issue.authorLogin,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      comments: issue.comments,
      body: issue.body,
      ...(issue.latestComment === undefined ? {} : { latestComment: issue.latestComment }),
      ...(pr === undefined ? {} : { pr })
    }
  })

  return {
    collectedAt: new Date(now).toISOString(),
    repoLabel: facts.repoLabel,
    host: { kind: 'github' },
    login: facts.login,
    rows: sortRows(rows)
  }
}

/**
 * The sessions this workspace holds are the renderer's fact, not the host's,
 * so they are folded in here rather than collected. An issue a session started
 * on is picked up whatever the host says about it.
 */
export function withSessions(
  board: IssueBoardSnapshot,
  references: ReadonlySet<string>
): IssueBoardSnapshot {
  if (references.size === 0) return board
  const rows = board.rows.map((row) =>
    references.has(row.reference) && row.group !== 'pickedUp'
      ? { ...row, group: 'pickedUp' as const }
      : row
  )
  return { ...board, rows: sortRows(rows) }
}

/** The chip's two numbers, computed in one place. */
export function issueCounts(board: IssueBoardSnapshot): {
  readonly open: number
  readonly yours: number
} {
  return {
    open: board.rows.length,
    // Only what the host says is yours to answer lights the chip. An unclaimed
    // issue is everybody's, so counting it would light the chip forever.
    yours: board.rows.filter((row) => row.group === 'assignedToYou').length
  }
}

/** First match wins, and an issue is in exactly one group. */
function group(
  issue: IssueFact,
  login: string,
  mentioned: ReadonlySet<number>
): IssueGroupId {
  // Work already under way outranks whose it is: the board's question is what
  // to pick up, and this one is taken.
  if (issue.pullRequests.length > 0) return 'pickedUp'
  if (issue.assignees.includes(login)) return 'assignedToYou'
  if (mentioned.has(issue.number)) return 'mentionsYou'
  if (issue.assignees.length === 0) return 'unclaimed'
  return 'assignedToOthers'
}

/** Group order, and most recently updated first inside each group. */
function sortRows(rows: readonly IssueRow[]): readonly IssueRow[] {
  return [...rows].sort((left, right) => {
    const byGroup = GROUP_ORDER.indexOf(left.group) - GROUP_ORDER.indexOf(right.group)
    if (byGroup !== 0) return byGroup
    // Parsed rather than compared as text: an ISO time carries an offset, and
    // two offsets do not sort as strings.
    return at(right.updatedAt) - at(left.updatedAt)
  })
}

function at(iso: string): number {
  const time = new Date(iso).getTime()
  return Number.isNaN(time) ? 0 : time
}
