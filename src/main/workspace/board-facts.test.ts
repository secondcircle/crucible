// @vitest-environment node
//
// The parsing, against output captured from real repositories, including the
// disagreement this feature exists for: git calls squash-merged branches
// unmerged and the host does not.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  dedupePullRequests,
  isGitHubRemote,
  mergeBranches,
  mergedByHeadQuery,
  parseAheadBehind,
  parseLeftRightCount,
  parseMergedByHead,
  parseNameWithOwner,
  parsePullRequests,
  parseRefs,
  parseTrunkRef
} from './board-facts'

function fixture(name: string): string {
  return readFileSync(new URL(`./board-fixtures/${name}`, import.meta.url), 'utf8')
}

const REFS = fixture('for-each-ref.txt')
const MERGED_REMOTES = fixture('branch-r-merged.txt')
const PULL_REQUESTS = fixture('gh-pr-list.json')
const REVIEWS = fixture('gh-pr-list-reviews.json')
const MERGED_BY_HEAD = fixture('gh-graphql-merged.json')

describe('what git says about refs', () => {
  it('reads every field of a captured for-each-ref line', () => {
    const first = parseRefs(REFS)[0]

    expect(first).toEqual({
      ref: 'refs/heads/backup-pre-surgery',
      tip: '77d9c7b4912a566428ac3dd0bc722c145fd416e8',
      // The angle brackets git writes around an address are not part of it.
      authorEmail: 't@example.com',
      touchedAt: '2026-07-27T12:27:47-05:00',
      ahead: 10,
      behind: 360,
      subject: 'chore(memory): backfill batch 1/6 (5 sessions)'
    })
  })

  it('leaves the counts absent where the format could not carry them', () => {
    const line = 'refs/heads/x\tabc\t<a@b.com>\t2026-08-19T19:42:30-05:00\t\ta subject'

    expect(parseRefs(line)[0]).toMatchObject({ subject: 'a subject' })
    expect(parseRefs(line)[0]?.ahead).toBeUndefined()
  })

  it('reads the counts both ways round, and refuses nonsense', () => {
    expect(parseAheadBehind('10 360')).toEqual({ ahead: 10, behind: 360 })
    // rev-list --left-right --count names the trunk's side first.
    expect(parseLeftRightCount('360\t10\n')).toEqual({ ahead: 10, behind: 360 })
    expect(parseAheadBehind('')).toBeUndefined()
    expect(parseAheadBehind('fatal: unknown field name')).toBeUndefined()
  })

  it('takes the trunk from origin/HEAD, and nothing from anything else', () => {
    expect(parseTrunkRef('refs/remotes/origin/main\n')).toBe('main')
    expect(parseTrunkRef('refs/remotes/origin/develop\n')).toBe('develop')
    expect(parseTrunkRef('')).toBeUndefined()
  })

  it('knows a GitHub origin from any other one', () => {
    expect(isGitHubRemote('git@github.com:secondcircle/pi-extensions.git')).toBe(true)
    expect(isGitHubRemote('https://github.com/secondcircle/pi-extensions.git')).toBe(true)
    expect(isGitHubRemote('https://bitbucket.org/team/thing.git')).toBe(false)
    expect(isGitHubRemote('')).toBe(false)
  })
})

describe('one row per branch', () => {
  const branches = mergeBranches(parseRefs(REFS), { checkedOut: 'role-delegation' })
  const named = (name: string) => branches.find((branch) => branch.name === name)

  it('merges the local head and the origin ref of one name into one branch', () => {
    expect(named('run-control-and-wake')).toMatchObject({ local: true, onOrigin: false })
    expect(named('issue-7-roster-parking')).toMatchObject({ local: false, onOrigin: true })
    expect(named('main')).toMatchObject({ local: true, onOrigin: true })
    // One row each, however many refs the name has.
    expect(branches.filter((branch) => branch.name === 'main')).toHaveLength(1)
  })

  it('never files origin/HEAD as a branch of anybody\u2019s', () => {
    expect(named('HEAD')).toBeUndefined()
  })

  it('flags the branch that is checked out, and only that one', () => {
    expect(branches.filter((branch) => branch.checkedOut).map((branch) => branch.name)).toEqual([
      'role-delegation'
    ])
  })

  it('carries the counts, the subject and the author of the tip', () => {
    expect(named('issue-9-id-namespacing')).toMatchObject({
      ahead: 1,
      behind: 93,
      authorEmail: 'ike.melancon@gmail.com',
      subject:
        "fix(task): a lead's workers are numbered under its own id, so a steer can no longer land on the wrong agent"
    })
  })

  it('judges by the copy that is further along when the two differ', () => {
    const merged = mergeBranches(
      parseRefs(
        [
          'refs/heads/thing\told\t<a@b.com>\t2026-08-01T10:00:00-05:00\t2 1\tthe local copy',
          'refs/remotes/origin/thing\tnew\t<a@b.com>\t2026-08-09T10:00:00-05:00\t5 1\tthe pushed copy'
        ].join('\n')
      ),
      {}
    )

    expect(merged[0]).toMatchObject({ tip: 'new', ahead: 5, local: true, onOrigin: true })
  })
})

describe('what gh says about pull requests', () => {
  const prs = parsePullRequests(PULL_REQUESTS)
  const numbered = (number: number) => prs.find((pr) => pr.number === number)

  it('reads a merged pull request, the head it merged and who merged it', () => {
    expect(numbered(45)).toMatchObject({
      state: 'merged',
      headRef: 'issue-7-roster-parking',
      headTip: '0e13b8dfe346f7368c8d4bf2aa4f5ba654b25a14',
      mergedBy: 'secondcircle',
      url: 'https://github.com/secondcircle/pi-extensions/pull/45'
    })
  })

  it('is the whole answer git could not give: merged work git calls unmerged', () => {
    // git names nothing but the trunk here, because every one of these landed
    // as a squash.
    expect(MERGED_REMOTES.trim().split('\n').map((line) => line.trim())).toEqual([
      'origin/HEAD -> origin/main',
      'origin/main'
    ])

    const merged = prs.filter((pr) => pr.state === 'merged').map((pr) => pr.number)
    expect(merged).toEqual(expect.arrayContaining([52, 45, 33, 14]))

    // And the branch tips still match the heads that were merged, which is
    // what makes them landed rather than reopened work.
    const branches = mergeBranches(parseRefs(REFS), {})
    const roster = branches.find((branch) => branch.name === 'issue-7-roster-parking')
    expect(roster?.tip).toBe(numbered(45)?.headTip)
    expect(roster?.ahead).toBe(5)
  })

  it('keeps a closed-but-unmerged pull request as closed, for the classifier to ignore', () => {
    expect(numbered(54)?.state).toBe('closed')
    expect(numbered(51)?.state).toBe('closed')
  })

  it('reads reviewers, assignees and a draft from open pull requests', () => {
    const reviewed = parsePullRequests(REVIEWS)

    expect(reviewed.find((pr) => pr.number === 14196)).toMatchObject({
      state: 'draft',
      reviewers: ['BagToad'],
      assignees: []
    })
    expect(reviewed.find((pr) => pr.number === 331851)).toMatchObject({
      state: 'open',
      reviewers: [],
      assignees: ['sandy081']
    })
  })

  it('counts the check rollup as failed, running and passed', () => {
    const reviewed = parsePullRequests(REVIEWS)

    // Three failures among eleven runs.
    expect(reviewed.find((pr) => pr.number === 13788)?.checks).toEqual({
      failed: 3,
      running: 0,
      passed: 8
    })
    // Still going, and counted apart from what has already passed.
    expect(reviewed.find((pr) => pr.number === 331851)?.checks).toEqual({
      failed: 0,
      running: 21,
      passed: 6
    })
    // Skipped runs are neither failing nor still going.
    expect(reviewed.find((pr) => pr.number === 14196)?.checks).toEqual({
      failed: 0,
      running: 0,
      passed: 7
    })
  })

  it('says nothing about checks where the host reported nothing', () => {
    expect(numbered(45)?.checks).toBeUndefined()
  })

  it('refuses an answer that is not gh\u2019s', () => {
    expect(() => parsePullRequests('gh: command not found')).toThrow()
    expect(() => parsePullRequests('{"message":"Not Found"}')).toThrow()
  })

  it('keeps one copy of a pull request that answered two questions', () => {
    const twice = [...parsePullRequests(REVIEWS), ...parsePullRequests(REVIEWS)]

    expect(twice).toHaveLength(6)
    expect(dedupePullRequests(twice).map((pr) => pr.number)).toEqual([14196, 13788, 331851])
  })
})

describe('asking the host about branches by name', () => {
  it('names the repository and one field per branch', () => {
    const query = mergedByHeadQuery('secondcircle', 'pi-extensions', [
      'issue-7-roster-parking',
      'wip/pre-wipe'
    ])

    expect(query).toContain('repository(owner: "secondcircle", name: "pi-extensions")')
    expect(query).toContain('b0: pullRequests(headRefName: "issue-7-roster-parking"')
    expect(query).toContain('b1: pullRequests(headRefName: "wip/pre-wipe"')
    // Merged only, and the newest merge of that head: the question is whether
    // this branch landed, not what else the repository has been doing.
    expect(query).toContain('states: [MERGED], first: 1')
    // No limit and no page for an old pull request to fall out of.
    expect(query).not.toMatch(/limit|first: [2-9]/)
  })

  it('quotes a branch name that would otherwise end the string', () => {
    const query = mergedByHeadQuery('o', 'n', ['odd"name\\here'])

    expect(query).toContain('headRefName: "odd\\"name\\\\here"')
  })

  it('reads the merged record back by the head ref each answer carries', () => {
    const merged = parseMergedByHead(MERGED_BY_HEAD)

    expect(merged.map((pr) => pr.number).sort((left, right) => left - right)).toEqual([
      14, 33, 45, 52
    ])
    expect(merged.find((pr) => pr.headRef === 'issue-7-roster-parking')).toEqual({
      number: 45,
      state: 'merged',
      url: 'https://github.com/secondcircle/pi-extensions/pull/45',
      headRef: 'issue-7-roster-parking',
      headTip: '0e13b8dfe346f7368c8d4bf2aa4f5ba654b25a14',
      title:
        'The advertised roster survives /reload, so a login change can no longer re-bill a live ' +
        "session's whole context",
      authorLogin: 'secondcircle',
      updatedAt: '2026-08-12T22:14:19Z',
      mergedBy: 'secondcircle',
      changesRequested: false,
      reviewers: [],
      assignees: []
    })
    // That branch's only pull request was closed unmerged, and the question
    // asks for merged ones.
    expect(merged.some((pr) => pr.headRef === 'issue-9-id-namespacing')).toBe(false)
  })

  it('says nothing for branches the host has never merged', () => {
    expect(parseMergedByHead('{"data":{"repository":{"b0":{"nodes":[]}}}}')).toEqual([])
  })

  it('refuses an answer that is not a repository', () => {
    expect(() => parseMergedByHead('gh: command not found')).toThrow()
    expect(() =>
      parseMergedByHead('{"data":{"repository":null},"errors":[{"type":"NOT_FOUND"}]}')
    ).toThrow()
  })
})

describe('what gh says the repository is called', () => {
  it('splits owner from name, and refuses anything else', () => {
    expect(parseNameWithOwner('secondcircle/pi-extensions\n')).toEqual({
      owner: 'secondcircle',
      name: 'pi-extensions'
    })
    expect(parseNameWithOwner('')).toBeUndefined()
    expect(parseNameWithOwner('pi-extensions\n')).toBeUndefined()
    expect(parseNameWithOwner('a/b/c\n')).toBeUndefined()
  })
})
