// @vitest-environment node
//
// The Jira collection, driven through the injected transport. No socket is
// opened, no credential is read from anywhere, and every answer below is one
// this test wrote.
import { describe, expect, it } from 'vitest'
import type { IssueBoardAnswer, IssueBoardSnapshot } from '../../shared/workspace/service'
import { collectJiraIssues } from './collect-jira-issues'
import type { JiraFetch } from './jira-client'
import type { JiraConfig } from './jira-config'

const NOW = Date.parse('2026-08-20T15:00:00.000Z')

const CONFIG: JiraConfig = {
  baseUrl: 'https://secondcircle.atlassian.net',
  email: 'ike@example.com',
  token: 'ATATT-secret',
  projectKey: 'EK'
}

const YOU = { accountId: '557058:you', displayName: 'Ike Melancon', emailAddress: 'ike@example.com' }
const MATE = { accountId: '557058:dev', displayName: 'Devi Raman' }

const MYSELF = JSON.stringify(YOU)

const DESCRIPTION = {
  type: 'doc',
  version: 1,
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'The importer drops line two.' }] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Reproduce' }] }
  ]
}

const SEARCH = JSON.stringify({
  isLast: true,
  issues: [
    {
      id: '10341',
      key: 'EK-341',
      fields: {
        summary: 'Enrolment import drops the second address line',
        description: DESCRIPTION,
        labels: ['defect', 'sev-high'],
        assignee: YOU,
        reporter: MATE,
        status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
        created: '2026-08-14T09:00:00.000+0000',
        updated: '2026-08-20T12:00:00.000+0000',
        comment: {
          total: 4,
          comments: [
            {
              author: MATE,
              created: '2026-08-15T09:00:00.000+0000',
              body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'older' }] }] }
            },
            {
              author: MATE,
              created: '2026-08-20T10:00:00.000+0000',
              body: {
                type: 'doc',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Confirmed on staging.' }] }]
              }
            }
          ]
        }
      }
    },
    {
      id: '10352',
      key: 'EK-352',
      fields: {
        summary: 'Nobody owns the onboarding checklist',
        description: null,
        labels: [],
        assignee: null,
        reporter: MATE,
        status: { name: 'To Do', statusCategory: { key: 'new' } },
        created: '2026-08-01T09:00:00.000+0000',
        updated: '2026-08-19T09:00:00.000+0000',
        comment: { total: 0, comments: [] }
      }
    },
    {
      id: '10349',
      key: 'EK-349',
      fields: {
        summary: 'Master data sync retries forever on a 409',
        labels: ['platform-gap'],
        assignee: MATE,
        reporter: MATE,
        created: '2026-08-02T09:00:00.000+0000',
        updated: '2026-08-18T09:00:00.000+0000'
      }
    }
  ]
})

interface Call {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
}

interface Wire {
  readonly impl: JiraFetch
  readonly calls: readonly Call[]
}

/** Answers whatever the first matching rule says, in the order given. */
function wire(
  rules: ReadonlyArray<[RegExp, { readonly status: number; readonly body: string }]>
): Wire {
  const calls: Call[] = []
  const impl: JiraFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers })
    const matched = rules.find(([pattern]) => pattern.test(url))
    const answer = matched?.[1] ?? { status: 404, body: '{}' }
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: async () => answer.body
    }
  }
  return { impl, calls }
}

const GOOD: ReadonlyArray<[RegExp, { status: number; body: string }]> = [
  [/\/myself$/, { status: 200, body: MYSELF }],
  [/\/search\/jql/, { status: 200, body: SEARCH }]
]

async function collect(
  rules: ReadonlyArray<[RegExp, { status: number; body: string }]> = GOOD,
  left = 30_000
): Promise<{ answer: IssueBoardAnswer; calls: readonly Call[] }> {
  const wired = wire(rules)
  const answer = await collectJiraIssues({
    config: CONFIG,
    fetchImpl: wired.impl,
    remaining: () => left,
    limit: 100,
    now: () => NOW
  })
  return { answer, calls: wired.calls }
}

async function board(): Promise<IssueBoardSnapshot> {
  const { answer } = await collect()
  if (answer.kind !== 'board') throw new Error(`expected a board, got ${answer.kind}`)
  return answer.board
}

describe('the board a reachable Jira answers with', () => {
  it('is labelled with the project and dated by the clock it was given', async () => {
    const snapshot = await board()

    expect(snapshot.repoLabel).toBe('EK')
    expect(snapshot.host).toEqual({ kind: 'jira' })
    expect(snapshot.collectedAt).toBe(new Date(NOW).toISOString())
  })

  it('knows you by display name, which is all that crosses the seam', async () => {
    expect((await board()).login).toBe('Ike Melancon')
  })

  it('groups by claim: yours, then unclaimed, then a teammate\u2019s', async () => {
    expect((await board()).rows.map((row) => [row.reference, row.group])).toEqual([
      ['EK-341', 'assignedToYou'],
      ['EK-352', 'unclaimed'],
      ['EK-349', 'assignedToOthers']
    ])
  })

  it('carries one whole row: key, number, title, URL, labels, people, comments', async () => {
    const row = (await board()).rows[0]

    expect(row).toMatchObject({
      number: 341,
      reference: 'EK-341',
      title: 'Enrolment import drops the second address line',
      url: 'https://secondcircle.atlassian.net/browse/EK-341',
      assignees: ['Ike Melancon'],
      authorLogin: 'Devi Raman',
      comments: 4,
      updatedAt: '2026-08-20T12:00:00.000+0000'
    })
    // Jira labels have no colour, so no row shows one.
    expect(row?.labels).toEqual([{ name: 'defect' }, { name: 'sev-high' }])
  })

  it('converts the description and the newest comment out of ADF', async () => {
    const row = (await board()).rows[0]

    expect(row?.body).toBe('The importer drops line two.\n\n## Reproduce')
    expect(row?.latestComment).toEqual({
      login: 'Devi Raman',
      at: '2026-08-20T10:00:00.000+0000',
      body: 'Confirmed on staging.'
    })
  })

  it('reads an absent description as the empty body the pane already handles', async () => {
    const rows = (await board()).rows

    expect(rows[1]?.body).toBe('')
    expect(rows[1]?.latestComment).toBeUndefined()
    // A row with no comment field at all is not a row with comments.
    expect(rows[2]?.comments).toBe(0)
  })

  it('never carries a pull request: picked-up-via-PR is Bitbucket\u2019s answer', async () => {
    expect((await board()).rows.every((row) => row.pr === undefined)).toBe(true)
  })

  it('never puts a row in the mentions group', async () => {
    expect((await board()).rows.some((row) => row.group === 'mentionsYou')).toBe(false)
  })
})

describe('what the collection asks for', () => {
  it('asks who you are, then the project\u2019s open issues, and nothing else', async () => {
    const { calls } = await collect()

    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe('https://secondcircle.atlassian.net/rest/api/3/myself')
    expect(calls[1].url).toContain('/rest/api/3/search/jql')
  })

  it('means by open that the status category is not done, never a status name', async () => {
    const { calls } = await collect()
    const jql = new URL(calls[1].url).searchParams.get('jql') ?? ''

    expect(jql).toBe('project = "EK" AND statusCategory != Done ORDER BY updated DESC')
    // This instance has done-category statuses called Closed and Withdrawn, so
    // a status-name comparison would show them as open forever.
    expect(jql).not.toMatch(/status\s*(=|!=|in)/)
  })

  it('asks for the board\u2019s hundred, newest update first, with the fields a row needs', async () => {
    const { calls } = await collect()
    const query = new URL(calls[1].url).searchParams

    expect(query.get('maxResults')).toBe('100')
    expect(query.get('fields')).toContain('summary')
    expect(query.get('fields')).toContain('description')
    expect(query.get('fields')).toContain('comment')
  })

  it('only ever issues GET, carrying HTTP Basic and nothing else', async () => {
    const { calls } = await collect()

    for (const call of calls) {
      expect(call.method).toBe('GET')
      expect(call.headers.authorization).toBe(
        `Basic ${Buffer.from('ike@example.com:ATATT-secret').toString('base64')}`
      )
      expect(Object.keys(call.headers).sort()).toEqual(['accept', 'authorization'])
    }
  })
})

describe('what never crosses to the renderer', () => {
  it('carries no token, no email and no account id, anywhere in the answer', async () => {
    const { answer } = await collect()
    const crossing = JSON.stringify(answer)

    expect(crossing).not.toContain('ATATT-secret')
    expect(crossing).not.toContain('ike@example.com')
    expect(crossing).not.toContain('557058')
  })

  it('says nothing of them in a refusal either', async () => {
    const refused = await collect([[/\/myself$/, { status: 401, body: '{"message":"nope"}' }]])
    const crossing = JSON.stringify(refused.answer)

    expect(crossing).not.toContain('ATATT-secret')
    expect(crossing).not.toContain('ike@example.com')
  })
})

describe('a Jira that could not answer', () => {
  const reason = async (
    rules: ReadonlyArray<[RegExp, { status: number; body: string }]>,
    left = 30_000
  ): Promise<string> => {
    const { answer } = await collect(rules, left)
    if (answer.kind !== 'unreachable') throw new Error(`expected unreachable, got ${answer.kind}`)
    return answer.reason
  }

  it('names the credential and its home when the credentials are refused', async () => {
    for (const status of [401, 403]) {
      expect(await reason([[/\/myself$/, { status, body: '{}' }]])).toBe(
        'Jira rejected the credentials in .env.local — check JIRA_API_TOKEN.'
      )
    }
  })

  it('names the project and the file that names it when the project is not there', async () => {
    const sentence =
      'Jira has no project EK visible to this account — check projectKey in .crucible/jira.json.'

    // What Jira Cloud actually answers a JQL naming a project you cannot see.
    expect(
      await reason([
        ...GOOD.slice(0, 1),
        [
          /\/search\/jql/,
          {
            status: 400,
            body: '{"errorMessages":["The value \'EK\' does not exist for the field \'project\'."],"errors":{}}'
          }
        ]
      ])
    ).toBe(sentence)

    expect(
      await reason([...GOOD.slice(0, 1), [/\/search\/jql/, { status: 404, body: '{}' }]])
    ).toBe(sentence)
  })

  it('says Jira could not be reached when the request fails outright', async () => {
    const impl: JiraFetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }
    const answer = await collectJiraIssues({
      config: CONFIG,
      fetchImpl: impl,
      remaining: () => 30_000,
      limit: 100,
      now: () => NOW
    })

    expect(answer).toEqual({
      kind: 'unreachable',
      reason:
        'Crucible could not reach Jira. Check JIRA_BASE_URL in .env.local and your connection.'
    })
  })

  it('answers rather than throwing when the base URL cannot form a request', async () => {
    // A person copying the host without its scheme, which nothing validates
    // before the first request is built.
    const wired = wire(GOOD)
    const answer = await collectJiraIssues({
      config: { ...CONFIG, baseUrl: 'secondcircle.atlassian.net' },
      fetchImpl: wired.impl,
      remaining: () => 30_000,
      limit: 100,
      now: () => NOW
    })

    // Never a rejection: a thrown TypeError leaves the board on "Reading
    // issues…" forever, which is exactly the dead state this answer exists
    // to prevent.
    expect(answer.kind).toBe('unreachable')
    expect(answer.kind === 'unreachable' && answer.reason).toContain('JIRA_BASE_URL')
  })

  it('says so for a server error too, rather than showing an empty board', async () => {
    expect(await reason([[/\/myself$/, { status: 500, body: 'gateway' }]])).toContain(
      'could not reach Jira'
    )
  })

  it('says it could not read an answer that is not JSON', async () => {
    expect(
      await reason([[/\/myself$/, { status: 200, body: '<html>signed in?</html>' }]])
    ).toBe('Jira answered something Crucible could not read.')
  })

  it('says the same of JSON that is not the answer it asked for', async () => {
    expect(
      await reason([
        [/\/myself$/, { status: 200, body: '{"nothing":true}' }],
        [/\/search\/jql/, { status: 200, body: SEARCH }]
      ])
    ).toBe('Jira answered something Crucible could not read.')

    expect(
      await reason([...GOOD.slice(0, 1), [/\/search\/jql/, { status: 200, body: '{"issues":null}' }]])
    ).toBe('Jira answered something Crucible could not read.')
  })

  it('fails rather than hangs when the collection is out of budget', async () => {
    const wired = wire(GOOD)
    const answer = await collectJiraIssues({
      config: CONFIG,
      fetchImpl: wired.impl,
      remaining: () => 0,
      limit: 100,
      now: () => NOW
    })

    expect(answer).toEqual({
      kind: 'unreachable',
      reason: 'Reading Jira took too long, so Crucible stopped.'
    })
    // Nothing was even asked: there was no time to ask it in.
    expect(wired.calls).toEqual([])
  })

  it('stops at the request that runs out of budget, part-way through', async () => {
    let asked = 0
    const wired = wire(GOOD)
    const answer = await collectJiraIssues({
      config: CONFIG,
      fetchImpl: async (url, init) => {
        asked += 1
        return wired.impl(url, init)
      },
      // Time enough for the first request and none for the second.
      remaining: () => (asked === 0 ? 5_000 : 0),
      limit: 100,
      now: () => NOW
    })

    expect(answer).toEqual({
      kind: 'unreachable',
      reason: 'Reading Jira took too long, so Crucible stopped.'
    })
    expect(asked).toBe(1)
  })
})
