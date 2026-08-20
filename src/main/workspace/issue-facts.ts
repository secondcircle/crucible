import type { IssueFact } from '../../shared/workspace/classify-issues'

// Nothing here spawns `gh`: the parsing is where the mistakes live, so it stays
// pure and drivable from captured output.

/** How many labels one row can show before the rest are the pane's business. */
const LABELS = 8

/** Assignees are a handful in practice; this only bounds a pathological one. */
const ASSIGNEES = 10

/** Cross references older than this on one issue say nothing new. */
const REFERENCES = 20

/**
 * One question for the whole board: every open issue with its body, its
 * labels, its newest comment and the pull requests that name it. Asked as
 * GraphQL because `gh issue list --json comments` would drag every comment of
 * every issue across to count them.
 */
export function openIssuesQuery(owner: string, name: string, limit: number): string {
  return `query {
  repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
    issues(states: OPEN, first: ${limit}, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        url
        body
        createdAt
        updatedAt
        author { login }
        assignees(first: ${ASSIGNEES}) { nodes { login } }
        labels(first: ${LABELS}) { nodes { name color } }
        comments(last: 1) {
          totalCount
          nodes { createdAt body author { login } }
        }
        timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: ${REFERENCES}) {
          nodes {
            ... on CrossReferencedEvent {
              source {
                ... on PullRequest { number url state isDraft }
              }
            }
          }
        }
      }
    }
  }
}
`
}

interface RawIssue {
  number?: number
  title?: string
  url?: string
  body?: string
  createdAt?: string
  updatedAt?: string
  author?: { login?: string } | null
  assignees?: { nodes?: readonly ({ login?: string } | null)[] | null } | null
  labels?: { nodes?: readonly ({ name?: string; color?: string } | null)[] | null } | null
  comments?: {
    totalCount?: number
    nodes?: readonly ({ createdAt?: string; body?: string; author?: { login?: string } | null } | null)[] | null
  } | null
  timelineItems?: { nodes?: readonly (RawTimelineItem | null)[] | null } | null
}

interface RawTimelineItem {
  source?: {
    number?: number
    url?: string
    state?: string
    isDraft?: boolean
  } | null
}

/**
 * Throws on anything that is not gh's answer, which the collector reports as an
 * unreachable host rather than as an empty board.
 */
export function parseIssues(stdout: string): readonly IssueFact[] {
  const parsed: unknown = JSON.parse(stdout)
  const nodes = (parsed as { data?: { repository?: { issues?: { nodes?: unknown } } } } | null)
    ?.data?.repository?.issues?.nodes
  if (!Array.isArray(nodes)) throw new Error('gh answered nothing about this repository.')

  const facts: IssueFact[] = []
  for (const raw of nodes as readonly (RawIssue | null)[]) {
    const number = raw?.number
    if (raw === null || raw === undefined || typeof number !== 'number') continue
    const comment = (raw.comments?.nodes ?? []).at(-1)
    const latest =
      comment === null || comment === undefined
        ? undefined
        : {
            login: comment.author?.login ?? '',
            at: comment.createdAt ?? '',
            body: comment.body ?? ''
          }
    facts.push({
      number,
      title: raw.title ?? '',
      url: raw.url ?? '',
      body: raw.body ?? '',
      createdAt: raw.createdAt ?? '',
      updatedAt: raw.updatedAt ?? '',
      authorLogin: raw.author?.login ?? '',
      assignees: logins(raw.assignees?.nodes ?? []),
      labels: labels(raw.labels?.nodes ?? []),
      comments: raw.comments?.totalCount ?? 0,
      ...(latest === undefined ? {} : { latestComment: latest }),
      pullRequests: openPullRequests(raw.timelineItems?.nodes ?? [])
    })
  }
  return facts
}

/** `gh issue list --mention @me --json number`, which is its own question. */
export function parseIssueNumbers(stdout: string): readonly number[] {
  const parsed: unknown = JSON.parse(stdout)
  if (!Array.isArray(parsed)) throw new Error('gh answered something that is not a list.')
  const numbers: number[] = []
  for (const raw of parsed as readonly { number?: unknown }[]) {
    if (typeof raw?.number === 'number') numbers.push(raw.number)
  }
  return numbers
}

/**
 * A cross reference can come from an issue, a merged pull request or a closed
 * one; only an open pull request means somebody is working on this now.
 */
function openPullRequests(
  nodes: readonly (RawTimelineItem | null)[]
): IssueFact['pullRequests'] {
  const byNumber = new Map<number, { number: number; state: 'open' | 'draft'; url: string }>()
  for (const node of nodes) {
    const source = node?.source
    const number = source?.number
    // An issue's cross reference has no state field at all, which is how a
    // pull request is told from one here.
    if (typeof number !== 'number' || source?.state !== 'OPEN') continue
    byNumber.set(number, {
      number,
      state: source.isDraft === true ? 'draft' : 'open',
      url: source.url ?? ''
    })
  }
  return [...byNumber.values()]
}

function logins(nodes: readonly ({ login?: string } | null)[]): readonly string[] {
  return nodes.flatMap((node) =>
    typeof node?.login === 'string' && node.login !== '' ? [node.login] : []
  )
}

function labels(
  nodes: readonly ({ name?: string; color?: string } | null)[]
): readonly { readonly name: string; readonly color?: string }[] {
  return nodes.flatMap((node) => {
    const name = node?.name
    if (typeof name !== 'string' || name === '') return []
    const color = node?.color
    return [
      typeof color === 'string' && color !== '' ? { name, color } : { name }
    ]
  })
}
