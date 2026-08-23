// @vitest-environment node
//
// The parsing, driven from captured gh output. Nothing here spawns anything.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { openIssuesQuery, parseIssueNumbers, parseIssues } from './issue-facts'

function fixture(name: string): string {
  return readFileSync(new URL(`./board-fixtures/${name}`, import.meta.url), 'utf8')
}

const ISSUES = fixture('gh-graphql-issues.json')

describe('the question the board asks', () => {
  it('names the repository as arguments rather than by pasting them in', () => {
    const query = openIssuesQuery('secondcircle', 'crucible', 100)
    expect(query).toContain('owner: "secondcircle"')
    expect(query).toContain('name: "crucible"')
  })

  it('asks for open issues only, newest movement first', () => {
    const query = openIssuesQuery('o', 'n', 25)
    expect(query).toContain('issues(states: OPEN, first: 25')
    expect(query).toContain('field: UPDATED_AT, direction: DESC')
  })

  it('asks for one comment and its count, never for every comment', () => {
    expect(openIssuesQuery('o', 'n', 1)).toContain('comments(last: 1)')
  })
})

describe('what one issue parses to', () => {
  const issues = parseIssues(ISSUES)

  it('reads every open issue the host answered with', () => {
    expect(issues.map((issue) => issue.number)).toEqual([128, 124, 117])
  })

  it('keeps the body whole, which is what the reading pane shows', () => {
    expect(issues[0]?.body).toContain('## Steps')
  })

  it("keeps each label's own colour", () => {
    expect(issues[0]?.labels).toEqual([
      { name: 'bug', color: 'd73a4a' },
      { name: 'ui', color: '5319e7' }
    ])
  })

  it('takes the newest comment and the count of all of them', () => {
    expect(issues[0]?.comments).toBe(3)
    expect(issues[0]?.latestComment).toEqual({
      login: 'maya',
      at: '2026-08-19T15:20:00Z',
      body: 'Reproduced on Max.'
    })
  })

  it('leaves the comment absent where the host sent none, count or not', () => {
    expect(issues[2]?.comments).toBe(1)
    expect(issues[2]?.latestComment).toBeUndefined()
  })

  it('reads assignees as logins, and none as unclaimed', () => {
    // A login is both the identity the grouping compares and the name shown.
    expect(issues[0]?.assignees).toEqual([{ id: 'ike', name: 'ike' }])
    expect(issues[2]?.assignees).toEqual([])
  })
})

describe('the pull requests that picked an issue up', () => {
  const issues = parseIssues(ISSUES)

  it('keeps the open ones and drops what is closed or merged', () => {
    expect(issues[2]?.pullRequests).toEqual([
      {
        number: 130,
        state: 'draft',
        url: 'https://github.com/secondcircle/crucible/pull/130'
      }
    ])
  })

  it('is empty where nothing cross-references the issue', () => {
    expect(issues[0]?.pullRequests).toEqual([])
  })
})

describe('an answer this build cannot read', () => {
  it('throws rather than reading as a repository with no issues', () => {
    expect(() => parseIssues('{"data":{"repository":null}}')).toThrow()
    expect(() => parseIssues('null')).toThrow()
  })

  it('throws on a mention list that is not a list', () => {
    expect(() => parseIssueNumbers('{"number":1}')).toThrow()
  })
})

describe('the mention question', () => {
  it('reads the numbers and nothing else', () => {
    expect(parseIssueNumbers('[{"number":124},{"number":9}]')).toEqual([124, 9])
  })

  it('skips an entry with no number rather than inventing one', () => {
    expect(parseIssueNumbers('[{"number":1},{"title":"x"}]')).toEqual([1])
  })
})
