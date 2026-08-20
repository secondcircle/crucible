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
  [/^gh pr list/, ok(fixture('gh-pr-list.json'))]
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

  it('treats an answer it cannot read as no answer at all', async () => {
    const { board: answered } = await board([
      ...GIT_REPO,
      [/^gh api user/, ok('secondcircle\n')],
      [/^gh repo view/, ok('secondcircle/pi-extensions\n')],
      [/^gh pr list/, ok('not json')]
    ])

    expect(answered.host).toEqual({ kind: 'github', reachable: false })
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
