// @vitest-environment node
//
// The issue board's judgment. Pure: every answer here is a function of the
// facts and the "now" they are judged against.
import { describe, expect, it } from 'vitest'
import {
  classifyIssues,
  issueCounts,
  withSessions,
  type IssueFact,
  type IssueFacts
} from './classify-issues'
import type { IssueBoardSnapshot, IssueGroupId } from './service'

const NOW = Date.parse('2026-08-20T15:00:00.000Z')

const DAY_MS = 24 * 60 * 60 * 1000

function issue(number: number, over: Partial<IssueFact> = {}): IssueFact {
  return {
    number,
    title: `issue ${number}`,
    url: `https://github.com/secondcircle/crucible/issues/${number}`,
    body: '',
    createdAt: new Date(NOW - 5 * DAY_MS).toISOString(),
    updatedAt: new Date(NOW - number * DAY_MS).toISOString(),
    authorLogin: 'maya',
    assignees: [],
    labels: [],
    comments: 0,
    pullRequests: [],
    ...over
  }
}

function board(issues: readonly IssueFact[], mentioned: readonly number[] = []): IssueBoardSnapshot {
  const facts: IssueFacts = {
    repoLabel: 'secondcircle/crucible',
    login: 'ike',
    issues,
    mentioned
  }
  return classifyIssues(facts, NOW)
}

const groupOf = (snapshot: IssueBoardSnapshot, number: number): IssueGroupId | undefined =>
  snapshot.rows.find((row) => row.number === number)?.group

describe('which group an issue lands in', () => {
  it('is yours when the host says you are assigned', () => {
    expect(groupOf(board([issue(1, { assignees: ['ike'] })]), 1)).toBe('assignedToYou')
  })

  it('mentions you when the host answered that question with it', () => {
    expect(groupOf(board([issue(1)], [1]), 1)).toBe('mentionsYou')
  })

  it('is unclaimed when nobody at all is assigned', () => {
    expect(groupOf(board([issue(1)]), 1)).toBe('unclaimed')
  })

  it("is somebody else's when they are assigned and you are not named", () => {
    expect(groupOf(board([issue(1, { assignees: ['maya'] })]), 1)).toBe('assignedToOthers')
  })

  it('is picked up when an open pull request names it, whoever it belongs to', () => {
    const taken = issue(1, {
      assignees: ['ike'],
      pullRequests: [{ number: 130, state: 'open', url: 'https://x/pull/130' }]
    })
    expect(groupOf(board([taken]), 1)).toBe('pickedUp')
  })

  it('being assigned to you outranks a mention of you', () => {
    expect(groupOf(board([issue(1, { assignees: ['ike'] })], [1]), 1)).toBe('assignedToYou')
  })
})

describe('what a row carries', () => {
  it('references the issue by repository name and number, which is what gh reads', () => {
    expect(board([issue(128)]).rows[0]?.reference).toBe('crucible#128')
  })

  it('shows the first pull request and keeps the rest as the reason it is taken', () => {
    const taken = issue(1, {
      pullRequests: [
        { number: 130, state: 'draft', url: 'https://x/pull/130' },
        { number: 131, state: 'open', url: 'https://x/pull/131' }
      ]
    })
    expect(board([taken]).rows[0]?.pr).toEqual({
      number: 130,
      state: 'draft',
      url: 'https://x/pull/130'
    })
  })

  it('carries the body and the newest comment, which is what deciding needs', () => {
    const read = issue(1, {
      body: '## Steps\n\n1. Sign in',
      comments: 3,
      latestComment: { login: 'maya', at: '2026-08-19T09:00:00.000Z', body: 'Reproduced on Max.' }
    })
    const row = board([read]).rows[0]
    expect(row?.body).toBe('## Steps\n\n1. Sign in')
    expect(row?.comments).toBe(3)
    expect(row?.latestComment?.login).toBe('maya')
  })
})

describe('the order the board is in', () => {
  it('is group order first, then most recently updated inside each group', () => {
    const snapshot = board([
      issue(4, { assignees: ['maya'] }),
      issue(3),
      issue(1),
      issue(2, { assignees: ['ike'] })
    ])
    expect(snapshot.rows.map((row) => row.number)).toEqual([2, 1, 3, 4])
  })

  it('sorts by the instant rather than by the text of two offsets', () => {
    const snapshot = board([
      issue(1, { updatedAt: '2026-08-20T09:00:00.000-05:00' }),
      issue(2, { updatedAt: '2026-08-20T13:30:00.000+00:00' })
    ])
    // 14:00Z beats 13:30Z, though "09:00" sorts before "13:30" as text.
    expect(snapshot.rows.map((row) => row.number)).toEqual([1, 2])
  })
})

describe('the sessions this workspace holds', () => {
  it('pick an issue up whatever the host says about it', () => {
    const folded = withSessions(board([issue(1)]), new Set(['crucible#1']))
    expect(groupOf(folded, 1)).toBe('pickedUp')
  })

  it('leave every other row exactly where it was', () => {
    const before = board([issue(1), issue(2, { assignees: ['ike'] })])
    const folded = withSessions(before, new Set(['crucible#1']))
    expect(groupOf(folded, 2)).toBe('assignedToYou')
  })

  it('change nothing at all when no session names an issue', () => {
    const before = board([issue(1)])
    expect(withSessions(before, new Set())).toBe(before)
  })

  it('re-sort the board, so a picked-up row is under its own heading', () => {
    const folded = withSessions(
      board([issue(1, { assignees: ['ike'] }), issue(2, { assignees: ['ike'] })]),
      new Set(['crucible#1'])
    )
    expect(folded.rows.map((row) => row.group)).toEqual(['assignedToYou', 'pickedUp'])
  })
})

describe('the chip above the board', () => {
  it('counts every open issue, and separately the ones assigned to you', () => {
    const snapshot = board([
      issue(1, { assignees: ['ike'] }),
      issue(2, { assignees: ['ike'] }),
      issue(3),
      issue(4, { assignees: ['maya'] })
    ])
    expect(issueCounts(snapshot)).toEqual({ open: 4, yours: 2 })
  })

  it('does not count an unclaimed issue as yours, which would light it forever', () => {
    expect(issueCounts(board([issue(1), issue(2)])).yours).toBe(0)
  })

  it('stops counting an issue of yours once it is picked up', () => {
    const folded = withSessions(board([issue(1, { assignees: ['ike'] })]), new Set(['crucible#1']))
    expect(issueCounts(folded).yours).toBe(0)
  })
})
