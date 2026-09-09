import { describe, expect, it } from 'vitest'
import { isGitHubRemote, parseNameWithOwner, parseTrunkRef } from './repository-facts'

describe('what git says about the repository', () => {
  it('takes the trunk from origin/HEAD, and nothing from anything else', () => {
    expect(parseTrunkRef('refs/remotes/origin/main\n')).toBe('main')
    expect(parseTrunkRef('refs/remotes/origin/develop\n')).toBe('develop')
    expect(parseTrunkRef('refs/remotes/origin/HEAD\n')).toBeUndefined()
    expect(parseTrunkRef('')).toBeUndefined()
  })

  it('knows a GitHub origin from any other one', () => {
    expect(isGitHubRemote('git@github.com:secondcircle/pi-extensions.git')).toBe(true)
    expect(isGitHubRemote('https://github.com/secondcircle/pi-extensions.git')).toBe(true)
    expect(isGitHubRemote('https://bitbucket.org/team/thing.git')).toBe(false)
    expect(isGitHubRemote('')).toBe(false)
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
