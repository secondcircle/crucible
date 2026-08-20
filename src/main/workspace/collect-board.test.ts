// @vitest-environment node
//
// The collector, driven from captured output: which commands it runs, in which
// order, and what it does when one of them cannot answer. Nothing is spawned
// here — the runner is the seam.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { BranchBoardSnapshot } from '../../shared/workspace/service'
import { collectBoard, type CommandOutcome, type CommandRunner } from './collect-board'

function fixture(name: string): string {
  return readFileSync(new URL(`./board-fixtures/${name}`, import.meta.url), 'utf8')
}

const NOW = Date.parse('2026-08-20T15:00:00.000Z')

const ok = (stdout: string): CommandOutcome => ({ ok: true, stdout, stderr: '' })
const no = (stderr = 'failed'): CommandOutcome => ({ ok: false, stdout: '', stderr })

interface Script {
  readonly runner: CommandRunner
  readonly ran: ReadonlyArray<{ readonly command: string; readonly args: readonly string[] }>
}

/** Answers whatever the first matching rule says, in the order given. */
function script(rules: ReadonlyArray<[RegExp, CommandOutcome]>): Script {
  const ran: Array<{ command: string; args: readonly string[] }> = []
  return {
    ran,
    runner: async (command, args) => {
      ran.push({ command, args: [...args] })
      const line = `${command} ${args.join(' ')}`
      const matched = rules.find(([pattern]) => pattern.test(line))
      return matched === undefined ? no(`nothing scripted for ${line}`) : matched[1]
    }
  }
}

const GIT_REPO: ReadonlyArray<[RegExp, CommandOutcome]> = [
  [/^git rev-parse --show-toplevel/, ok('/repos/pi-extensions\n')],
  [/^git config --get user\.email/, ok('ike.melancon@gmail.com\n')],
  [/^git remote get-url origin/, ok('git@github.com:secondcircle/pi-extensions.git\n')],
  [/^git fetch --prune origin/, ok('')],
  [/^git symbolic-ref --quiet refs\/remotes\/origin\/HEAD/, ok('refs/remotes/origin/main\n')],
  [/^git symbolic-ref --quiet --short HEAD/, ok('role-delegation\n')],
  [/^git for-each-ref/, ok(fixture('for-each-ref.txt'))]
]

const GH: ReadonlyArray<[RegExp, CommandOutcome]> = [
  [/^gh api user/, ok('secondcircle\n')],
  [/^gh repo view/, ok('secondcircle/pi-extensions\n')],
  // Nothing of that repository's is open: the three open-pull-request
  // questions really did answer an empty list when this was captured.
  [/^gh pr list/, ok('[]')],
  [/^gh api graphql/, ok(fixture('gh-graphql-merged.json'))]
]

async function board(
  rules: ReadonlyArray<[RegExp, CommandOutcome]>,
  workspacePath = '/repos/pi-extensions'
): Promise<{
  readonly board: BranchBoardSnapshot
  readonly ran: Script['ran']
}> {
  const scripted = script(rules)
  const answer = await collectBoard(scripted.runner, workspacePath, { now: () => NOW })
  if (answer.kind !== 'board') throw new Error(`expected a board, got ${answer.kind}`)
  return { board: answer.board, ran: scripted.ran }
}

describe('a folder that is not a repository', () => {
  it('answers noRepository, which is an answer and not a failure', async () => {
    const scripted = script([[/^git rev-parse/, no('not a git repository')]])

    expect(await collectBoard(scripted.runner, '/tmp/notes', { now: () => NOW })).toEqual({
      kind: 'noRepository'
    })
    // Nothing else is asked of a folder that has no repository in it.
    expect(scripted.ran).toHaveLength(1)
  })
})

describe('what the collector runs', () => {
  it('fetches remote-tracking refs and touches nothing else', async () => {
    const { ran } = await board([...GIT_REPO, ...GH])
    const gitRuns = ran.filter((run) => run.command === 'git').map((run) => run.args.join(' '))

    expect(gitRuns).toContain('fetch --prune origin')
    // The one write, and the whole of it: no checkout, no branch, no push, no
    // delete, on any schedule or control.
    for (const forbidden of ['checkout', 'switch', 'push', 'branch -d', 'branch -D', 'reset']) {
      expect(gitRuns.some((run) => run.startsWith(forbidden))).toBe(false)
    }
  })

  it('never fetches a repository with no origin, and falls back to a local trunk', async () => {
    const { board: answered, ran } = await board(
      [
      [/^git rev-parse --show-toplevel/, ok('/repos/resume-site\n')],
      [/^git config --get user\.email/, ok('ike@example.com\n')],
      [/^git remote get-url origin/, no('No such remote')],
      [/^git show-ref --verify --quiet refs\/heads\/main/, ok('')],
      [/^git symbolic-ref --quiet --short HEAD/, ok('main\n')],
      [
        /^git for-each-ref/,
        ok('refs/heads/og-image\tabc\t<ike@example.com>\t2026-08-11T10:00:00Z\t0 3\ta card\n')
      ]
      ],
      '/repos/resume-site'
    )

    expect(ran.some((run) => run.args.includes('fetch'))).toBe(false)
    expect(answered.trunk).toBe('main')
    // No host at all: the board is git-only and says so by having no host.
    expect(answered.host).toBeUndefined()
    expect(answered.repoLabel).toBe('/repos/resume-site')
  })
})

describe('how the host is asked', () => {
  it('asks about landing branch by branch, never off a page of recent pull requests', async () => {
    const { ran } = await board([...GIT_REPO, ...GH])
    const ghRuns = ran.filter((run) => run.command === 'gh').map((run) => run.args.join(' '))

    // Every list the collector asks for is a list of open pull requests, which
    // is a human-sized thing. Whether a branch landed is never read off one:
    // the newest hundred pull requests of a busy repository say nothing about a
    // branch squash-merged a year ago.
    const lists = ghRuns.filter((run) => run.startsWith('pr list'))
    expect(lists).toHaveLength(3)
    for (const list of lists) expect(list).toContain('--state open')
    expect(ghRuns.some((run) => run.includes('--state all'))).toBe(false)
    expect(ghRuns.some((run) => run.includes('--state merged'))).toBe(false)

    // The three questions the board answers, each named to the authenticated
    // login rather than to whatever the repository has been up to lately.
    expect(lists[0]).toContain('--author secondcircle')
    expect(lists[1]).toContain('--search review-requested:secondcircle')
    expect(lists[2]).toContain('--assignee secondcircle')

    // And the merged record is asked for by head ref, for every branch in
    // front of the collector, with no limit anywhere in the question.
    const asked = ghRuns.filter((run) => run.startsWith('api graphql')).join('\n')
    for (const branch of [
      'issue-7-roster-parking',
      'issue-11-tier-aware-addendum',
      'plan/plan-20260410-ueno',
      'wip/pre-wipe-stash',
      'backup-pre-surgery'
    ]) {
      expect(asked).toContain(`headRefName: "${branch}"`)
    }
    // The trunk is what everything is measured against, never a row and never
    // a question.
    expect(asked).not.toContain('headRefName: "main"')
  })

  it('names every branch once, however many there are, in batches', async () => {
    const many = Array.from(
      { length: 120 },
      (_, index) =>
        `refs/remotes/origin/team/branch-${index}\ttip${index}\t<them@example.com>\t` +
        `2026-08-1${index % 10}T10:00:00Z\t3 1\twork ${index}\n`
    ).join('')
    const { ran } = await board([
      ...GIT_REPO.filter(([pattern]) => !pattern.test('git for-each-ref')),
      [/^git for-each-ref/, ok(many)],
      ...GH
    ])

    const queries = ran
      .filter((run) => run.command === 'gh' && run.args[1] === 'graphql')
      .map((run) => run.args.join(' '))
    // 120 branches, fifty to a request: three questions, not one per branch and
    // not one enormous one.
    expect(queries).toHaveLength(3)
    for (const query of queries) {
      expect([...query.matchAll(/headRefName:/g)].length).toBeLessThanOrEqual(50)
    }
    const asked = queries.join('\n')
    for (let index = 0; index < 120; index += 1) {
      expect([...asked.matchAll(new RegExp(`"team/branch-${index}"`, 'g'))]).toHaveLength(1)
    }
  })

  it('spends no question on a branch whose pull request is open right now', async () => {
    const openPr = JSON.stringify([
      {
        number: 61,
        state: 'OPEN',
        isDraft: false,
        headRefName: 'role-delegation',
        headRefOid: '962ee065786f931acd3075830d922c03dc1c4ba9',
        title: 'A lead\u2019s switcher stops running blind',
        url: 'https://github.com/secondcircle/pi-extensions/pull/61',
        updatedAt: '2026-08-13T16:08:40Z',
        author: { login: 'secondcircle' },
        mergedBy: null,
        statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }],
        reviewDecision: '',
        reviewRequests: [],
        assignees: []
      }
    ])
    const { board: answered, ran } = await board([
      ...GIT_REPO,
      [/^gh api user/, ok('secondcircle\n')],
      [/^gh repo view/, ok('secondcircle/pi-extensions\n')],
      [/^gh pr list --state open --author/, ok(openPr)],
      [/^gh pr list/, ok('[]')],
      [/^gh api graphql/, ok(fixture('gh-graphql-merged.json'))]
    ])

    const asked = ran
      .filter((run) => run.command === 'gh' && run.args[1] === 'graphql')
      .map((run) => run.args.join(' '))
      .join('\n')
    expect(asked).not.toContain('headRefName: "role-delegation"')
    expect(answered.rows.find((row) => row.name === 'role-delegation')).toMatchObject({
      group: 'inFlight',
      signal: { kind: 'checksFailed', count: 1 },
      pr: { number: 61, state: 'open' }
    })
  })

  it('keeps one row for a pull request that answered two of the questions', async () => {
    const naming = JSON.stringify([
      {
        number: 77,
        state: 'OPEN',
        isDraft: false,
        headRefName: 'their-work',
        headRefOid: 'aaa111',
        title: 'Something of theirs that names you twice',
        url: 'https://github.com/secondcircle/pi-extensions/pull/77',
        updatedAt: '2026-08-19T09:00:00Z',
        author: { login: 'someone-else' },
        mergedBy: null,
        statusCheckRollup: [],
        reviewDecision: '',
        reviewRequests: [{ login: 'secondcircle' }],
        assignees: [{ login: 'secondcircle' }]
      }
    ])
    const { board: answered } = await board([
      ...GIT_REPO,
      [/^gh api user/, ok('secondcircle\n')],
      [/^gh repo view/, ok('secondcircle/pi-extensions\n')],
      [/^gh pr list --state open --author/, ok('[]')],
      // Requested reviewer and assignee are two questions, and this pull
      // request is the answer to both.
      [/^gh pr list/, ok(naming)],
      [/^gh api graphql/, ok(fixture('gh-graphql-merged.json'))]
    ])

    const waiting = answered.rows.filter((row) => row.group === 'waitingOnYou')
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({
      name: 'their-work',
      signal: { kind: 'yourReview' },
      drift: { kind: 'author', login: 'someone-else' },
      pr: { number: 77, state: 'open' }
    })
  })
})

describe('a repository with a host that answers', () => {
  it('lands the squash-merged branches git calls unmerged', async () => {
    const { board: answered } = await board([...GIT_REPO, ...GH])
    const landed = answered.rows
      .filter((row) => row.group === 'landed')
      .map((row) => row.name)

    expect(answered.host).toEqual({ kind: 'github', reachable: true })
    expect(answered.repoLabel).toBe('secondcircle/pi-extensions')
    expect(landed).toEqual(
      expect.arrayContaining([
        'issue-7-roster-parking',
        'issue-6-monitor-leads',
        'compaction-economics'
      ])
    )
    expect(
      answered.rows.find((row) => row.name === 'issue-7-roster-parking')
    ).toMatchObject({
      drift: { kind: 'squashed' },
      signal: { kind: 'merged', byYou: true },
      pr: { number: 45, state: 'merged' }
    })
  })

  it('keeps out the branch whose tip moved after its pull request merged', async () => {
    const { board: answered } = await board([...GIT_REPO, ...GH])

    // Real drift in that repository: #14 merged head b78022ac, and
    // origin/issue-11-tier-aware-addendum stands at fc08b0e9. Two commits of
    // that branch are in no trunk, so it is not finished work.
    expect(answered.rows.find((row) => row.name === 'issue-11-tier-aware-addendum')).toMatchObject(
      {
        group: 'inFlight',
        drift: { kind: 'counts', ahead: 2, behind: 159 },
        pr: { number: 14, state: 'merged' }
      }
    )
  })

  it('reads the checked-out branch, and whose the branches are', async () => {
    const { board: answered } = await board([...GIT_REPO, ...GH])

    expect(answered.rows.filter((row) => row.checkedOut).map((row) => row.name)).toEqual([
      'role-delegation'
    ])
    // The one branch in that repository whose tip somebody else authored.
    expect(answered.rows.filter((row) => !row.yours).map((row) => row.name)).toEqual([
      'backup-pre-surgery'
    ])
  })
})

describe('a GitHub origin with no gh to answer for it', () => {
  it('says the host is unreachable and shows git only, inventing nothing', async () => {
    const { board: answered } = await board([
      ...GIT_REPO,
      [/^gh api user/, no('gh: command not found')]
    ])

    expect(answered.host).toEqual({ kind: 'github', reachable: false })
    expect(answered.repoLabel).toBe('/repos/pi-extensions')
    expect(answered.rows.some((row) => row.pr !== undefined)).toBe(false)
    expect(answered.rows.some((row) => row.group === 'waitingOnYou')).toBe(false)
    // Landed falls back to ancestry, which is all git can say on its own.
    expect(answered.rows.find((row) => row.name === 'issue-7-roster-parking')?.group).toBe(
      'inFlight'
    )
  })

  it('shows git only rather than half of what the host knows', async () => {
    // The merged sweep is where a slow or rate-limited host gives out, and a
    // board missing half its merged records would file landed work as stale.
    const { board: answered } = await board([
      ...GIT_REPO,
      ...GH.filter(([pattern]) => !pattern.test('gh api graphql')),
      [/^gh api graphql/, no('API rate limit exceeded')]
    ])

    expect(answered.host).toEqual({ kind: 'github', reachable: false })
    expect(answered.rows.some((row) => row.pr !== undefined)).toBe(false)
  })

  it('shows git only when any one of the open questions goes unanswered', async () => {
    const { board: answered } = await board([
      ...GIT_REPO,
      [/^gh api user/, ok('secondcircle\n')],
      [/^gh repo view/, ok('secondcircle/pi-extensions\n')],
      [/^gh pr list --state open --author/, ok('[]')],
      [/^gh pr list --state open --search/, no('could not search')],
      [/^gh pr list/, ok('[]')],
      [/^gh api graphql/, ok(fixture('gh-graphql-merged.json'))]
    ])

    expect(answered.host).toEqual({ kind: 'github', reachable: false })
  })

  it('treats an answer it cannot read as no answer at all', async () => {
    const { board: answered } = await board([
      ...GIT_REPO,
      [/^gh api user/, ok('secondcircle\n')],
      [/^gh repo view/, ok('secondcircle/pi-extensions\n')],
      [/^gh pr list/, ok('not json')]
    ])

    expect(answered.host).toEqual({ kind: 'github', reachable: false })
  })

  it('treats a repository gh cannot see as no answer at all', async () => {
    const { board: answered } = await board([
      ...GIT_REPO,
      [/^gh api user/, ok('secondcircle\n')],
      [/^gh repo view/, ok('\n')]
    ])

    expect(answered.host).toEqual({ kind: 'github', reachable: false })
    expect(answered.repoLabel).toBe('/repos/pi-extensions')
  })
})

describe('when git cannot count for itself', () => {
  it('asks rev-list one branch at a time, and says the same thing', async () => {
    const plain =
      'refs/heads/og-image\tabc\t<ike@example.com>\t2026-08-11T10:00:00Z\t\ta card\n' +
      'refs/heads/main\tmain-tip\t<ike@example.com>\t2026-08-20T10:00:00Z\t\ttrunk\n'
    let asked = 0
    const scripted = script([
      [/^git rev-parse --show-toplevel/, ok('/repos/resume-site\n')],
      [/^git config --get user\.email/, ok('ike@example.com\n')],
      [/^git remote get-url origin/, no()],
      [/^git show-ref --verify --quiet refs\/heads\/main/, ok('')],
      [/^git symbolic-ref --quiet --short HEAD/, ok('main\n')],
      // The ahead-behind field is what git before 2.41 refuses.
      [/%\(ahead-behind/, no('fatal: unknown field name')],
      [/^git for-each-ref/, ok(plain)],
      [/^git rev-list/, ok('7\t0\n')]
    ])
    const answer = await collectBoard(scripted.runner, '/repos/resume-site', {
      now: () => {
        asked += 1
        return NOW
      }
    })
    if (answer.kind !== 'board') throw new Error('expected a board')

    expect(asked).toBeGreaterThan(0)
    expect(answer.board.rows).toHaveLength(1)
    expect(answer.board.rows[0]).toMatchObject({
      name: 'og-image',
      group: 'landed',
      drift: { kind: 'counts', ahead: 0, behind: 7 }
    })
  })
})

describe('what a collection refuses to do', () => {
  it('fails rather than answering a board with no trunk to measure against', async () => {
    const scripted = script([
      [/^git rev-parse --show-toplevel/, ok('/repos/odd\n')],
      [/^git config --get user\.email/, ok('ike@example.com\n')],
      [/^git remote get-url origin/, no()],
      [/^git show-ref/, no()]
    ])

    await expect(collectBoard(scripted.runner, '/repos/odd', { now: () => NOW })).rejects.toThrow(
      /trunk/
    )
  })

  it('fails rather than hanging once its budget is spent', async () => {
    let clock = NOW
    const scripted = script(GIT_REPO)
    // Every command takes ten seconds of the collection's own clock.
    const slow: CommandRunner = async (command, args, options) => {
      clock += 10_000
      return scripted.runner(command, args, options)
    }

    await expect(
      collectBoard(slow, '/repos/pi-extensions', { now: () => clock })
    ).rejects.toThrow(/took too long/)
  })
})
