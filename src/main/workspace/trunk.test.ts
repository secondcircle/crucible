// @vitest-environment node
//
// The trunk rule every scheduled fire branches from, tested once here rather
// than in the shape of each caller. The runner is the seam: nothing is
// spawned.
import { describe, expect, it } from 'vitest'
import { findTrunk, refreshRefs, type GitAnswer, type GitRunner } from './trunk'

const ok = (stdout: string): GitAnswer => ({ ok: true, stdout })
const no = (): GitAnswer => ({ ok: false, stdout: '' })

interface Script {
  readonly git: GitRunner
  readonly ran: readonly string[]
}

function script(rules: ReadonlyArray<[RegExp, GitAnswer]>): Script {
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

describe('refreshing the refs', () => {
  it('fetches with prune when there is an origin, and says what it is', async () => {
    const scripted = script([
      [/^remote get-url origin/, ok('git@github.com:secondcircle/crucible.git\n')],
      [/^fetch --prune origin/, ok('')]
    ])

    const { originUrl } = await refreshRefs(scripted.git)

    expect(originUrl).toBe('git@github.com:secondcircle/crucible.git')
    expect(scripted.ran).toEqual([
      'remote get-url origin',
      'fetch --prune origin'
    ])
  })

  it('fetches nothing where there is no origin', async () => {
    const scripted = script([])

    expect((await refreshRefs(scripted.git)).originUrl).toBe('')
    expect(scripted.ran).toEqual(['remote get-url origin'])
  })

  // Offline is not a reason to refuse: the refs on hand stand.
  it('tolerates a fetch that fails', async () => {
    const scripted = script([
      [/^remote get-url origin/, ok('git@github.com:secondcircle/crucible.git\n')],
      [/^fetch --prune origin/, no()]
    ])

    await expect(refreshRefs(scripted.git)).resolves.toEqual({
      originUrl: 'git@github.com:secondcircle/crucible.git'
    })
  })
})

describe('finding the trunk', () => {
  it('takes origin/HEAD first', async () => {
    const scripted = script([
      [/^symbolic-ref --quiet refs\/remotes\/origin\/HEAD/, ok('refs/remotes/origin/trunk\n')],
      [/^show-ref/, ok('')]
    ])

    expect(await findTrunk(scripted.git, true)).toEqual({
      name: 'trunk',
      ref: 'refs/remotes/origin/trunk'
    })
  })

  it('falls back to a local main, then a local master', async () => {
    const mained = script([[/^show-ref --verify --quiet refs\/heads\/main/, ok('')]])
    expect(await findTrunk(mained.git, false)).toEqual({
      name: 'main',
      ref: 'refs/heads/main'
    })

    const mastered = script([[/^show-ref --verify --quiet refs\/heads\/master/, ok('')]])
    expect(await findTrunk(mastered.git, false)).toEqual({
      name: 'master',
      ref: 'refs/heads/master'
    })
  })

  it('asks nothing of a remote that is not there', async () => {
    const scripted = script([[/^show-ref --verify --quiet refs\/heads\/main/, ok('')]])

    await findTrunk(scripted.git, false)

    expect(scripted.ran.some((line) => line.includes('origin/HEAD'))).toBe(false)
  })

  it('has no answer where nothing names a trunk', async () => {
    const scripted = script([])
    expect(await findTrunk(scripted.git, true)).toBeUndefined()
  })
})
