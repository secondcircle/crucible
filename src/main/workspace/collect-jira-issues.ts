import { classifyIssues } from '../../shared/workspace/classify-issues'
import type { IssueBoardAnswer } from '../../shared/workspace/service'
import { createJiraClient, type JiraFailure, type JiraFetch } from './jira-client'
import type { JiraConfig } from './jira-config'
import { parseJiraIssues, parseJiraSelf } from './jira-facts'

// Reads and nothing else: no issue is ever transitioned, assigned, labelled or
// commented from here, and the client below has no method that could.
//
// Identity boundary: the token, the email and the account id stay in this
// process. What crosses to the renderer is the display name, the project key
// and the issues themselves — never a credential, not even inside a reason.

const CREDENTIALS_REFUSED =
  'Jira rejected the credentials in .env.local — check JIRA_API_TOKEN.'

const NOT_REACHED =
  'Crucible could not reach Jira. Check JIRA_BASE_URL in .env.local and your connection.'

const TOO_SLOW = 'Reading Jira took too long, so Crucible stopped.'

const UNREADABLE = 'Jira answered something Crucible could not read.'

export async function collectJiraIssues({
  config,
  fetchImpl,
  remaining,
  limit,
  now
}: {
  readonly config: JiraConfig
  readonly fetchImpl?: JiraFetch
  /** What is left of the collection's one budget. */
  readonly remaining: () => number
  readonly limit: number
  /** Read when the board is stamped, so its age is how old the answer is. */
  readonly now: () => number
}): Promise<IssueBoardAnswer> {
  const client = createJiraClient({ config, fetchImpl, remaining })

  const identity = await client.myself()
  if (!identity.ok) return { kind: 'unreachable', reason: reasonFor(identity.failure) }

  const listed = await client.openIssues(limit)
  if (!listed.ok) {
    return { kind: 'unreachable', reason: reasonFor(listed.failure, config.projectKey) }
  }

  try {
    const you = parseJiraSelf(identity.payload)
    return {
      kind: 'board',
      board: classifyIssues(
        {
          repoLabel: config.projectKey,
          host: { kind: 'jira' },
          // The account id is what "you" means while the rows are grouped; the
          // display name is all the snapshot carries.
          you: { id: you.accountId, name: you.displayName },
          issues: parseJiraIssues(listed.payload, config.baseUrl),
          // Mention detection is a host-side search Jira gets no equivalent of
          // this round, so the mentions group never occurs on this board.
          mentioned: []
        },
        now()
      )
    }
  } catch {
    return { kind: 'unreachable', reason: UNREADABLE }
  }
}

/** A sentence a person can act on, and never one that echoes a credential. */
function reasonFor(failure: JiraFailure, projectKey?: string): string {
  switch (failure.kind) {
    case 'unauthorized':
      return CREDENTIALS_REFUSED
    case 'timedOut':
      return TOO_SLOW
    case 'unreadable':
      return UNREADABLE
    case 'rejected':
      // A JQL refusal naming the project is the one refusal with its own fix:
      // the file that names the project is the file to correct.
      return projectKey !== undefined && namesProject(failure, projectKey)
        ? `Jira has no project ${projectKey} visible to this account — check projectKey in .crucible/jira.json.`
        : NOT_REACHED
    default:
      return NOT_REACHED
  }
}

function namesProject(
  failure: { readonly status: number; readonly messages: readonly string[] },
  projectKey: string
): boolean {
  if (failure.status === 404) return true
  return failure.messages.some(
    (message) => message.includes(projectKey) || message.includes("field 'project'")
  )
}
