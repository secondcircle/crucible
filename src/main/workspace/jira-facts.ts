import type { IssueFact, IssuePerson } from '../../shared/workspace/classify-issues'
import { adfToMarkdown } from './jira-adf'

// Nothing here opens a socket: the parsing is where the mistakes live, so it
// stays pure and drivable from a captured answer. Throws on anything that is
// not Jira's answer, which the collector reports as a host that answered
// something Crucible could not read.

/** Who the credentials belong to. The account id never leaves main. */
export interface JiraSelf {
  readonly accountId: string
  readonly displayName: string
}

export function parseJiraSelf(payload: unknown): JiraSelf {
  const record = asRecord(payload)
  const accountId = record?.['accountId']
  if (typeof accountId !== 'string' || accountId === '') {
    throw new Error('Jira named no account for these credentials.')
  }
  const displayName = record?.['displayName']
  return {
    accountId,
    displayName: typeof displayName === 'string' && displayName !== '' ? displayName : accountId
  }
}

/**
 * One search answer as board facts. The key carries the reference form
 * (`EK-341`) and its numeric tail is the issue's number, so a row on this board
 * reads and sorts exactly as a GitHub one does.
 */
export function parseJiraIssues(payload: unknown, baseUrl: string): readonly IssueFact[] {
  const record = asRecord(payload)
  const issues = record?.['issues']
  if (!Array.isArray(issues)) throw new Error('Jira answered no issues at all.')

  const facts: IssueFact[] = []
  for (const raw of issues) {
    const issue = asRecord(raw)
    const key = issue?.['key']
    if (issue === undefined || typeof key !== 'string') continue
    const number = numberIn(key)
    if (number === undefined) continue

    const fields = asRecord(issue['fields']) ?? {}
    const assignee = person(fields['assignee'])
    const comments = asRecord(fields['comment'])
    const latest = newestComment(comments)

    facts.push({
      number,
      title: text(fields['summary']),
      url: `${baseUrl}/browse/${key}`,
      body: adfToMarkdown(fields['description']),
      createdAt: text(fields['created']),
      updatedAt: text(fields['updated']),
      authorLogin: person(fields['reporter'])?.name ?? '',
      // Jira holds one assignee at most, so this list is empty or a single name.
      assignees: assignee === undefined ? [] : [assignee],
      // Jira labels carry no colour, so no row shows one.
      labels: labels(fields['labels']),
      comments: count(comments?.['total']),
      ...(latest === undefined ? {} : { latestComment: latest }),
      // Picked-up-via-pull-request is Bitbucket's answer to give, and Bitbucket
      // is not this round. A Jira row reaches picked up through a session only.
      pullRequests: []
    })
  }
  return facts
}

/** The numeric tail of `EK-341`. */
function numberIn(key: string): number | undefined {
  const tail = key.slice(key.lastIndexOf('-') + 1)
  if (!/^\d+$/.test(tail)) return undefined
  return Number.parseInt(tail, 10)
}

function person(value: unknown): IssuePerson | undefined {
  const record = asRecord(value)
  const id = record?.['accountId']
  if (typeof id !== 'string' || id === '') return undefined
  const name = record?.['displayName']
  // The id groups and the name shows; a nameless account shows as its id rather
  // than as an empty cell.
  return { id, name: typeof name === 'string' && name !== '' ? name : id }
}

function labels(value: unknown): readonly { readonly name: string }[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((label) => (typeof label === 'string' && label !== '' ? [{ name: label }] : []))
}

/**
 * The newest comment the search answer happens to carry, which is what the
 * reading pane shows. Jira returns the oldest first and the collection asks no
 * follow-up question, so the last of what came back is the newest there is.
 */
function newestComment(
  comments: Record<string, unknown> | undefined
): IssueFact['latestComment'] | undefined {
  const list = comments?.['comments']
  if (!Array.isArray(list)) return undefined
  const newest = asRecord(list.at(-1))
  if (newest === undefined) return undefined
  return {
    login: person(newest['author'])?.name ?? '',
    at: text(newest['created']),
    body: adfToMarkdown(newest['body'])
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
}
