// @vitest-environment node
//
// Where a scheduled run branches from. The git runner is the seam, so the
// fetch, the tolerance and the trunk ladder are all checkable with nothing
// spawned and no repository on disk.
import { describe, expect, it } from 'vitest'
import type { GitAnswer, GitRunner } from '../workspace/trunk'
import { scheduledBase } from './scheduled-base'

const ok = (stdout: string): GitAnswer => ({ ok: true, stdout })
const no = (): GitAnswer => ({ ok: false, stdout: '' })

function script(rules: ReadonlyArray<[RegExp, GitAnswer]>): {
  readonly git: GitRunner
  readonly ran: readonly string[]
} {
  const ran: string[] = []
  return {
    ran,
    git: async (...args) => {
      const line = args.join(' ')
      ran.push(line)
      return rules.find(([pattern]) => pattern.test(line))?.[1] ?? no()
    }
  }
}

describe('the base a scheduled fire branches from', () => {
  it('fetches the refs fresh and takes the trunk from origin/HEAD', async () => {
    const scripted = script([
      [/^remote get-url origin/, ok('git@github.com:secondcircle/crucible.git\n')],
      [/^fetch --prune origin/, ok('')],
      [/^symbolic-ref --quiet refs\/remotes\/origin\/HEAD/, ok('refs/remotes/origin/main\n')]
    ])

    expect(await scheduledBase('/repos/crucible', scripted.git)).toBe('refs/remotes/origin/main')
    expect(scripted.ran[1]).toBe('fetch --prune origin')
  })

  it('skips the fetch where there is no origin, and takes the local trunk', async () => {
    const scripted = script([[/^show-ref --verify --quiet refs\/heads\/master/, ok('')]])

    expect(await scheduledBase('/repos/crucible', scripted.git)).toBe('refs/heads/master')
    expect(scripted.ran.some((line) => line.startsWith('fetch'))).toBe(false)
  })

  // Offline is not a reason to skip a fire: the refs on hand stand.
  it('tolerates a fetch that fails', async () => {
    const scripted = script([
      [/^remote get-url origin/, ok('git@github.com:secondcircle/crucible.git\n')],
      [/^fetch --prune origin/, no()],
      [/^symbolic-ref --quiet refs\/remotes\/origin\/HEAD/, ok('refs/remotes/origin/main\n')]
    ])

    expect(await scheduledBase('/repos/crucible', scripted.git)).toBe('refs/remotes/origin/main')
  })

  it('refuses where nothing names a trunk, before a run record exists', async () => {
    const scripted = script([])

    await expect(scheduledBase('/repos/crucible', scripted.git)).rejects.toThrow(/trunk/)
  })
})
