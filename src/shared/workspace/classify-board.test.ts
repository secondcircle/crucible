// @vitest-environment node
//
// The board's judgment, tested where it is made. Every case here is a question
// git alone cannot answer, or one it answers wrongly once a squash merge is in
// play.
import { describe, expect, it } from 'vitest'
import {
  boardCounts,
  classifyBoard,
  type BoardFacts,
  type BranchFact,
  type PullRequestFact
} from './classify-board'
import type { BoardRow } from './service'

const NOW = Date.parse('2026-08-20T15:00:00.000Z')

const DAY = 24 * 60 * 60 * 1000

/** ISO of a moment this many days before the collection's "now". */
function daysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString()
}

function branch(overrides: Partial<BranchFact> & { readonly name: string }): BranchFact {
  return {
    tip: `tip-${overrides.name}`,
    local: true,
    onOrigin: true,
    checkedOut: false,
    subject: 'a commit',
    authorEmail: 'ike@example.com',
    touchedAt: daysAgo(1),
    ahead: 3,
    behind: 10,
    ...overrides
  }
}

function pullRequest(
  overrides: Partial<PullRequestFact> & { readonly number: number; readonly headRef: string }
): PullRequestFact {
  return {
    state: 'open',
    url: `https://github.com/secondcircle/pi-extensions/pull/${overrides.number}`,
    headTip: `tip-${overrides.headRef}`,
    title: 'a pull request',
    authorLogin: 'secondcircle',
    updatedAt: daysAgo(1),
    changesRequested: false,
    reviewers: [],
    assignees: [],
    ...overrides
  }
}

function hosted(
  branches: readonly BranchFact[],
  pullRequests: readonly PullRequestFact[] = []
): BoardFacts {
  return {
    trunk: 'main',
    repoLabel: 'secondcircle/pi-extensions',
    userEmail: 'ike@example.com',
    login: 'secondcircle',
    host: { kind: 'github', reachable: true },
    branches,
    pullRequests
  }
}

function gitOnly(branches: readonly BranchFact[]): BoardFacts {
  return {
    trunk: 'main',
    repoLabel: '/repos/resume-site',
    userEmail: 'ike@example.com',
    branches,
    pullRequests: []
  }
}

function rowOf(facts: BoardFacts, name: string): BoardRow {
  const found = classifyBoard(facts, NOW).rows.find((row) => row.name === name)
  if (found === undefined) throw new Error(`no row for ${name}`)
  return found
}

describe('landed', () => {
  it('files a squash-merged branch whose tip never moved, and says the host said so', () => {
    const facts = hosted(
      [branch({ name: 'issue-7-roster-parking', tip: 'abc', ahead: 5, behind: 104 })],
      [
        pullRequest({
          number: 45,
          headRef: 'issue-7-roster-parking',
          state: 'merged',
          headTip: 'abc',
          mergedBy: 'secondcircle'
        })
      ]
    )

    expect(rowOf(facts, 'issue-7-roster-parking')).toMatchObject({
      group: 'landed',
      // Five commits ahead of main and landed anyway: the whole reason this
      // feature exists.
      drift: { kind: 'squashed' },
      signal: { kind: 'merged', byYou: true },
      pr: { number: 45, state: 'merged' }
    })
  })

  it('keeps a branch out when its tip moved past the merge point', () => {
    const facts = hosted(
      [branch({ name: 'issue-7-roster-parking', tip: 'newer', ahead: 2 })],
      [
        pullRequest({
          number: 45,
          headRef: 'issue-7-roster-parking',
          state: 'merged',
          headTip: 'abc',
          mergedBy: 'secondcircle'
        })
      ]
    )

    const row = rowOf(facts, 'issue-7-roster-parking')
    expect(row.group).toBe('inFlight')
    // The merged pull request is still real, and still shown.
    expect(row.pr).toMatchObject({ number: 45, state: 'merged' })
  })

  it('says merged rather than merged by you when somebody else merged it', () => {
    const facts = hosted(
      [branch({ name: 'issue-11', tip: 'abc' })],
      [
        pullRequest({
          number: 14,
          headRef: 'issue-11',
          state: 'merged',
          headTip: 'abc',
          mergedBy: 'tamsin'
        })
      ]
    )

    expect(rowOf(facts, 'issue-11').signal).toEqual({ kind: 'merged', byYou: false })
  })

  it('lands a branch on ancestry alone, with no pull request anywhere', () => {
    const facts = hosted([branch({ name: 'build/build-260819-f1wn', ahead: 0, behind: 4 })])

    expect(rowOf(facts, 'build/build-260819-f1wn')).toMatchObject({
      group: 'landed',
      drift: { kind: 'counts', ahead: 0, behind: 4 },
      signal: { kind: 'inTrunkHistory' }
    })
    expect(rowOf(facts, 'build/build-260819-f1wn').pr).toBeUndefined()
  })

  it('lands on ancestry with no host connected at all', () => {
    const facts = gitOnly([branch({ name: 'drop-jquery', ahead: 0, behind: 12 })])

    expect(rowOf(facts, 'drop-jquery')).toMatchObject({
      group: 'landed',
      signal: { kind: 'inTrunkHistory' }
    })
  })

  it('has no age limit: a year-old landing is landed, never stale', () => {
    const facts = gitOnly([branch({ name: 'og-image', ahead: 0, touchedAt: daysAgo(400) })])

    expect(rowOf(facts, 'og-image').group).toBe('landed')
  })

  it('never files the trunk itself as a row', () => {
    const facts = gitOnly([branch({ name: 'main', ahead: 0 }), branch({ name: 'og-image' })])

    expect(classifyBoard(facts, NOW).rows.map((row) => row.name)).toEqual(['og-image'])
  })
})

describe('waiting on you', () => {
  const theirs = pullRequest({
    number: 61,
    headRef: 'tam/retry-budget-guard',
    title: 'a retry budget that cannot outlive its parent turn',
    authorLogin: 'tamsin',
    reviewers: ['secondcircle'],
    updatedAt: daysAgo(2)
  })

  it('files a review request with no branch in this clone', () => {
    const facts = hosted([], [theirs])

    expect(rowOf(facts, 'tam/retry-budget-guard')).toMatchObject({
      group: 'waitingOnYou',
      yours: false,
      local: false,
      subject: 'a retry budget that cannot outlive its parent turn',
      drift: { kind: 'author', login: 'tamsin' },
      signal: { kind: 'yourReview' },
      pr: { number: 61, state: 'open' }
    })
  })

  it('lets review win over assignment when both name you', () => {
    const facts = hosted([], [{ ...theirs, assignees: ['secondcircle'] }])

    expect(rowOf(facts, 'tam/retry-budget-guard').signal).toEqual({ kind: 'yourReview' })
  })

  it('files an assignment on its own as assigned to you', () => {
    const facts = hosted([], [{ ...theirs, reviewers: [], assignees: ['secondcircle'] }])

    expect(rowOf(facts, 'tam/retry-budget-guard').signal).toEqual({ kind: 'assignedToYou' })
  })

  it('files the branch here and nowhere else when this clone has a copy', () => {
    const facts = hosted([branch({ name: 'tam/retry-budget-guard', local: true })], [theirs])
    const board = classifyBoard(facts, NOW)

    expect(board.rows.filter((row) => row.name === 'tam/retry-budget-guard')).toHaveLength(1)
    expect(board.rows[0]?.group).toBe('waitingOnYou')
    // Presence comes from the clone even though the row is the pull request's.
    expect(board.rows[0]?.local).toBe(true)
  })

  it('ignores your own pull requests, whoever they name', () => {
    const facts = hosted(
      [branch({ name: 'issue-9' })],
      [pullRequest({ number: 54, headRef: 'issue-9', reviewers: ['secondcircle'] })]
    )

    expect(rowOf(facts, 'issue-9').group).toBe('inFlight')
  })

  it('is empty on a git-only board, whatever pull requests were collected', () => {
    const facts: BoardFacts = { ...gitOnly([]), pullRequests: [theirs] }

    expect(classifyBoard(facts, NOW).rows).toEqual([])
  })
})

describe('in flight, local only and stale', () => {
  it('keeps an open pull request in flight at any age', () => {
    const facts = hosted(
      [branch({ name: 'issue-6', touchedAt: daysAgo(200) })],
      [pullRequest({ number: 51, headRef: 'issue-6' })]
    )

    expect(rowOf(facts, 'issue-6').group).toBe('inFlight')
  })

  it('files a pushed branch with no pull request as in flight, with no PR of its own', () => {
    const facts = hosted([branch({ name: 'run-control-and-wake', onOrigin: true })])

    const row = rowOf(facts, 'run-control-and-wake')
    expect(row.group).toBe('inFlight')
    expect(row.pr).toBeUndefined()
    expect(row.signal).toBeUndefined()
  })

  it('files a never-pushed recent branch as local only', () => {
    const facts = hosted([branch({ name: 'role-delegation', onOrigin: false })])

    expect(rowOf(facts, 'role-delegation').group).toBe('localOnly')
  })

  it('files a pull-request-less branch untouched over thirty days as stale', () => {
    const facts = hosted([branch({ name: 'backup-pre-surgery', touchedAt: daysAgo(31) })])

    expect(rowOf(facts, 'backup-pre-surgery').group).toBe('stale')
  })

  it('holds the thirty-day line exactly where it says it is', () => {
    const inside = hosted([
      branch({ name: 'edge', touchedAt: new Date(NOW - 30 * DAY + 1000).toISOString() })
    ])
    const outside = hosted([
      branch({ name: 'edge', touchedAt: new Date(NOW - 30 * DAY - 1000).toISOString() })
    ])

    expect(rowOf(inside, 'edge').group).toBe('inFlight')
    expect(rowOf(outside, 'edge').group).toBe('stale')
  })

  it('ignores a closed-but-unmerged pull request entirely', () => {
    const facts = hosted(
      [branch({ name: 'issue-9-id-namespacing', onOrigin: false })],
      [pullRequest({ number: 54, headRef: 'issue-9-id-namespacing', state: 'closed' })]
    )

    const row = rowOf(facts, 'issue-9-id-namespacing')
    // Treated as a branch with no pull request at all, which is what it is now.
    expect(row.group).toBe('localOnly')
    expect(row.pr).toBeUndefined()
  })
})

describe('signals on your own pull requests', () => {
  function signalOf(overrides: Partial<PullRequestFact>): BoardRow['signal'] {
    const facts = hosted(
      [branch({ name: 'issue-9' })],
      [pullRequest({ number: 54, headRef: 'issue-9', ...overrides })]
    )
    return rowOf(facts, 'issue-9').signal
  }

  it('puts changes requested ahead of everything else', () => {
    expect(
      signalOf({ changesRequested: true, checks: { failed: 2, running: 0, passed: 1 } })
    ).toEqual({ kind: 'changesRequested' })
  })

  it('counts failed checks, then running, then passed', () => {
    expect(signalOf({ checks: { failed: 2, running: 1, passed: 8 } })).toEqual({
      kind: 'checksFailed',
      count: 2
    })
    expect(signalOf({ checks: { failed: 0, running: 21, passed: 6 } })).toEqual({
      kind: 'checksRunning'
    })
    expect(signalOf({ checks: { failed: 0, running: 0, passed: 11 } })).toEqual({
      kind: 'checksPassed'
    })
  })

  it('says nothing where the host reported nothing', () => {
    expect(signalOf({})).toBeUndefined()
    expect(signalOf({ checks: { failed: 0, running: 0, passed: 0 } })).toBeUndefined()
  })

  it('carries a draft through to the pull request cell', () => {
    const facts = hosted(
      [branch({ name: 'crucible/synthesis-260818-7hci' })],
      [pullRequest({ number: 57, headRef: 'crucible/synthesis-260818-7hci', state: 'draft' })]
    )

    expect(rowOf(facts, 'crucible/synthesis-260818-7hci').pr).toMatchObject({
      number: 57,
      state: 'draft'
    })
  })
})

describe('whose branch it is', () => {
  it('is yours when the tip author is this clone\u2019s configured email', () => {
    const facts = hosted([
      branch({ name: 'mine', authorEmail: 'IKE@example.com' }),
      branch({ name: 'theirs', authorEmail: 'tamsin@example.com' })
    ])

    expect(rowOf(facts, 'mine').yours).toBe(true)
    expect(rowOf(facts, 'theirs').yours).toBe(false)
  })

  it('still carries everyone else\u2019s branches, tagged, so widening is instant', () => {
    const facts = hosted([
      branch({ name: 'mine' }),
      branch({ name: 'theirs', authorEmail: 'tamsin@example.com' })
    ])

    expect(classifyBoard(facts, NOW).rows.map((row) => row.name).sort()).toEqual([
      'mine',
      'theirs'
    ])
  })
})

describe('the snapshot itself', () => {
  it('carries the host, the trunk and the repo label it was collected with', () => {
    const board = classifyBoard(hosted([]), NOW)

    expect(board).toMatchObject({
      collectedAt: new Date(NOW).toISOString(),
      trunk: 'main',
      repoLabel: 'secondcircle/pi-extensions',
      host: { kind: 'github', reachable: true }
    })
  })

  it('leaves the host absent on a git-only repository', () => {
    expect(classifyBoard(gitOnly([]), NOW).host).toBeUndefined()
  })

  it('falls back to ancestry when the host is unreachable, and invents no pull requests', () => {
    const facts: BoardFacts = {
      ...hosted([branch({ name: 'og-image', ahead: 0 })], [pullRequest({ number: 1, headRef: 'og-image' })]),
      host: { kind: 'github', reachable: false }
    }
    const board = classifyBoard(facts, NOW)

    expect(board.host).toEqual({ kind: 'github', reachable: false })
    expect(board.rows[0]).toMatchObject({ group: 'landed', signal: { kind: 'inTrunkHistory' } })
    expect(board.rows[0]?.pr).toBeUndefined()
  })

  it('orders the rows by group, then most recently touched first', () => {
    const facts = hosted([
      branch({ name: 'older-flight', touchedAt: daysAgo(5) }),
      branch({ name: 'newer-flight', touchedAt: daysAgo(1) }),
      branch({ name: 'landed-one', ahead: 0, touchedAt: daysAgo(9) })
    ])

    expect(classifyBoard(facts, NOW).rows.map((row) => row.name)).toEqual([
      'landed-one',
      'newer-flight',
      'older-flight'
    ])
  })
})

describe('the counts the chip and the badge show', () => {
  const facts = hosted(
    [
      branch({ name: 'landed-mine', ahead: 0 }),
      branch({ name: 'landed-theirs', ahead: 0, authorEmail: 'tamsin@example.com' }),
      branch({ name: 'failing' }),
      branch({ name: 'changes' }),
      branch({ name: 'passing' }),
      branch({ name: 'stale-one', touchedAt: daysAgo(90) }),
      branch({ name: 'local-one', onOrigin: false })
    ],
    [
      pullRequest({
        number: 1,
        headRef: 'failing',
        checks: { failed: 2, running: 0, passed: 3 }
      }),
      pullRequest({ number: 2, headRef: 'changes', changesRequested: true }),
      pullRequest({ number: 3, headRef: 'passing', checks: { failed: 0, running: 0, passed: 4 } }),
      pullRequest({
        number: 61,
        headRef: 'tam/retry-budget-guard',
        authorLogin: 'tamsin',
        reviewers: ['secondcircle']
      }),
      pullRequest({
        number: 59,
        headRef: 'bot/deps-bump-aug',
        authorLogin: 'dependabot',
        assignees: ['secondcircle']
      })
    ]
  )

  it('counts your landed branches and the three signals that need you', () => {
    // Failing checks, changes requested, and a review requested of you. The
    // assigned row and the stale and local-only rows are on the board and in
    // no count.
    expect(boardCounts(classifyBoard(facts, NOW))).toEqual({ landed: 1, needYou: 3 })
  })

  it('counts nothing on a board where nothing is asking for you', () => {
    const quiet = hosted([branch({ name: 'stale-one', touchedAt: daysAgo(90) })])

    expect(boardCounts(classifyBoard(quiet, NOW))).toEqual({ landed: 0, needYou: 0 })
  })

  it('leaves somebody else\u2019s failing checks out of the count', () => {
    const others = hosted(
      [branch({ name: 'theirs', authorEmail: 'tamsin@example.com' })],
      [pullRequest({ number: 9, headRef: 'theirs', checks: { failed: 1, running: 0, passed: 0 } })]
    )

    expect(boardCounts(classifyBoard(others, NOW)).needYou).toBe(0)
  })
})
