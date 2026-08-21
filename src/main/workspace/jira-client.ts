import type { JiraConfig } from './jira-config'

// Crucible's own Jira client, main-process only and structurally read-only:
// there is one request function, its method is the literal 'GET', and no
// caller can hand it another. Nothing here transitions, assigns, labels or
// comments, and no code path could grow into one — the same rule the GitHub
// collectors follow.
//
// The transport is injected, the same fetch-like seam the quota adapters use,
// so no test opens a socket.

/** Narrow on purpose: the global `fetch` satisfies it, and so does a stand-in. */
export type JiraFetch = (
  url: string,
  init: {
    readonly method: 'GET'
    readonly headers: Record<string, string>
    readonly signal: AbortSignal
  }
) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>

export type JiraFailure =
  | { readonly kind: 'unauthorized' }
  // The host answered and refused: the messages are its own, kept for the
  // collector to read and never printed to the renderer verbatim.
  | { readonly kind: 'rejected'; readonly status: number; readonly messages: readonly string[] }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'unreadable' }
  /** The collection's whole budget ran out before this request could finish. */
  | { readonly kind: 'timedOut' }

export type JiraAnswer =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly failure: JiraFailure }

/** How long any single request may take, inside whatever budget is left. */
const REQUEST_MS = 15_000

/** Everything one board row and its reading pane need, in one request. */
export const JIRA_ISSUE_FIELDS =
  'summary,description,labels,assignee,reporter,status,created,updated,comment'

export interface JiraClient {
  /** Who the credentials belong to: an account id and a display name. */
  myself(): Promise<JiraAnswer>
  // The project's open issues, newest update first. Open means the status
  // category is not done, never a status-name comparison: a Jira instance can
  // have dozens of done-category statuses called Closed, Withdrawn or Resolved.
  openIssues(limit: number): Promise<JiraAnswer>
}

export function createJiraClient({
  config,
  fetchImpl,
  remaining
}: {
  readonly config: JiraConfig
  readonly fetchImpl?: JiraFetch
  /** Milliseconds left in the collection's budget; nothing starts past zero. */
  readonly remaining: () => number
}): JiraClient {
  const doFetch: JiraFetch = fetchImpl ?? (globalThis.fetch as unknown as JiraFetch)
  // HTTP Basic, built once. It never leaves this closure: no answer, log line
  // or error carries it.
  const authorization = `Basic ${Buffer.from(`${config.email}:${config.token}`).toString('base64')}`

  async function get(path: string, query: Record<string, string> = {}): Promise<JiraAnswer> {
    const ms = Math.min(REQUEST_MS, remaining())
    if (ms <= 0) return { ok: false, failure: { kind: 'timedOut' } }

    let body: string
    let status: number
    try {
      // The URL is built in here on purpose. `new URL` throws on a base URL
      // that is only a hostname, and a request that cannot even be addressed is
      // a failure of the same kind as one that never arrives: this function
      // answers every caller, so nothing can throw out of a collection and
      // leave the board reading forever.
      const url = new URL(`${config.baseUrl}/rest/api/3${path}`)
      for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)

      const res = await doFetch(url.toString(), {
        method: 'GET',
        headers: { authorization, accept: 'application/json' },
        // Node's fetch has no default timeout, so the socket is bounded here.
        signal: AbortSignal.timeout(ms)
      })
      status = res.status
      body = await res.text()
      if (!res.ok) {
        if (status === 401 || status === 403) return { ok: false, failure: { kind: 'unauthorized' } }
        return {
          ok: false,
          failure: { kind: 'rejected', status, messages: errorMessages(body) }
        }
      }
    } catch {
      return { ok: false, failure: { kind: 'unreachable' } }
    }

    try {
      return { ok: true, payload: JSON.parse(body) }
    } catch {
      return { ok: false, failure: { kind: 'unreadable' } }
    }
  }

  return {
    myself: () => get('/myself'),
    openIssues: (limit: number) =>
      get('/search/jql', {
        jql: `project = "${config.projectKey}" AND statusCategory != Done ORDER BY updated DESC`,
        maxResults: String(limit),
        fields: JIRA_ISSUE_FIELDS
      })
  }
}

/** Jira's own `errorMessages`, which is where a bad project key shows up. */
function errorMessages(body: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(body)
    const messages = (parsed as { errorMessages?: unknown } | null)?.errorMessages
    if (!Array.isArray(messages)) return []
    return messages.filter((message): message is string => typeof message === 'string')
  } catch {
    return []
  }
}
