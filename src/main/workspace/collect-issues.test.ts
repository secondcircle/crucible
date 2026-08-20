// @vitest-environment node
//
// The issue collector, driven from captured output. Nothing is spawned here:
// the runner is the seam.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { IssueBoardSnapshot } from '../../shared/workspace/service'
import type { CommandOutcome, CommandRunner } from './collect-board'
import { collectIssues } from './collect-issues'

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

const HOSTED: ReadonlyArray<[RegExp, CommandOutcome]> = [
  [/^git rev-parse --show-toplevel/, ok('/repos/crucible\n')],
  [/^git remote get-url origin/, ok('git@github.com:secondcircle/crucible.git\n')],
  [/^gh api user/, ok('ike\n')],
  [/^gh repo view/, ok('secondcircle/crucible\n')],
  [/^gh api graphql/, ok(fixture('gh-graphql-issues.json'))],
  [/^gh issue list/, ok('[{"number":124}]')]
]

async function collect(
  rules: ReadonlyArray<[RegExp, CommandOutcome]>,
  workspacePath = '/repos/crucible'
): Promise<{ answer: Awaited<ReturnType<typeof collectIssues>>; ran: Script['ran'] }> {
  const scripted = script(rules)
  const answer = await collectIssues(scripted.runner, workspacePath, { now: () => NOW })
  return { answer, ran: scripted.ran }
}

async function board(
  rules: ReadonlyArray<[RegExp, CommandOutcome]> = HOSTED
): Promise<IssueBoardSnapshot> {
  const { answer } = await collect(rules)
  if (answer.kind !== 'board') throw new Error(`expected a board, got ${answer.kind}`)
  return answer.board
}

describe('a workspace with no issue host', () => {
  it('answers so for a folder that is not a repository', async () => {
    const { answer } = await collect([[/^git rev-parse/, no()]])
    expect(answer).toEqual({ kind: 'noIssueHost' })
  })

  it('answers so for a repository with no origin at all', async () => {
    const { answer } = await collect([
      [/^git rev-parse/, ok('/repos/notes\n')],
      [/^git remote get-url origin/, no()]
    ])
    expect(answer).toEqual({ kind: 'noIssueHost' })
  })

  it('answers so for an origin no issue host answers for', async () => {
    const { answer, ran } = await collect([
      [/^git rev-parse/, ok('/repos/notes\n')],
      [/^git remote get-url origin/, ok('git@gitlab.com:ike/notes.git\n')]
    ])
    expect(answer).toEqual({ kind: 'noIssueHost' })
    // Nothing was asked of gh about a host that is not GitHub.
    expect(ran.some((call) => call.command === 'gh')).toBe(false)
  })
})

describe('a host that could not answer', () => {
  it('says so rather than showing a repository with no issues in it', async () => {
    const { answer } = await collect([
      ...HOSTED.slice(0, 2),
      [/^gh api user/, no('gh: command not found')]
    ])
    expect(answer).toEqual({ kind: 'unreachable', reason: 'gh: command not found' })
  })

  it('offers the fix where gh said nothing at all', async () => {
    const { answer } = await collect([
      ...HOSTED.slice(0, 2),
      [/^gh api user/, { ok: false, stdout: '', stderr: '' }]
    ])
    if (answer.kind !== 'unreachable') throw new Error('expected an unreachable host')
    expect(answer.reason).toContain('gh auth login')
  })

  it('says so when the issue list itself fails, half a board being worse', async () => {
    const { answer } = await collect([
      ...HOSTED.filter(([pattern]) => !pattern.test('gh api graphql')),
      [/^gh api graphql/, no('HTTP 502')]
    ])
    expect(answer).toEqual({ kind: 'unreachable', reason: 'HTTP 502' })
  })

  it('says so when gh answers something this build cannot read', async () => {
    const { answer } = await collect([
      ...HOSTED.filter(([pattern]) => !pattern.test('gh api graphql')),
      [/^gh api graphql/, ok('{"data":{"repository":null}}')]
    ])
    if (answer.kind !== 'unreachable') throw new Error('expected an unreachable host')
    expect(answer.reason).toContain('could not read')
  })
})

describe('the board a reachable host answers with', () => {
  it('is labelled with the repository the host named', async () => {
    expect((await board()).repoLabel).toBe('secondcircle/crucible')
  })

  it('knows who you are, which is what "yours" on this board means', async () => {
    expect((await board()).login).toBe('ike')
  })

  it('groups by what the host said, mentions included', async () => {
    const rows = (await board()).rows
    expect(rows.map((row) => [row.number, row.group])).toEqual([
      [128, 'assignedToYou'],
      [124, 'mentionsYou'],
      [117, 'pickedUp']
    ])
  })

  it('dates itself by the clock it was given', async () => {
    expect((await board()).collectedAt).toBe(new Date(NOW).toISOString())
  })
})

describe('what the collection never does', () => {
  it('only ever reads: no close, no assign, no label, no comment', async () => {
    const { ran } = await collect(HOSTED)
    const lines = ran.map((call) => `${call.command} ${call.args.join(' ')}`)
    for (const line of lines) {
      expect(line).not.toMatch(/gh issue (close|edit|comment|reopen|delete|transfer)/)
      expect(line).not.toMatch(/--add-assignee|--add-label|--remove-label/)
    }
    // The two gh writes it could plausibly make are the ones it never makes.
    expect(lines.every((line) => /^git |^gh (api|repo view|issue list)/.test(line))).toBe(true)
  })
})
