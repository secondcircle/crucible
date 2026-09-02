// @vitest-environment node
//
// What CI publishes, as a pure function over two versions. Every push to main
// ships something; a hand-bump is respected; nothing is committed back.
import { describe, expect, it } from 'vitest'
import { formatVersion, parseVersion, type SemVer } from '../src/shared/app-update/semver'
import { choose } from './publish-version'

const at = (text: string): SemVer => parseVersion(text)!

const chosen = (repo: string, published?: string): string =>
  formatVersion(choose(at(repo), published === undefined ? undefined : at(published)))

describe('the version CI publishes', () => {
  it('is the repo’s own on the first publish, when the registry holds nothing', () => {
    expect(chosen('0.1.0')).toBe('0.1.0')
  })

  it('is the repo’s own when the author bumped it by hand', () => {
    expect(chosen('0.2.0', '0.1.7')).toBe('0.2.0')
    expect(chosen('1.0.0', '0.9.12')).toBe('1.0.0')
  })

  it('is a patch above what shipped on a plain push', () => {
    expect(chosen('0.1.0', '0.1.7')).toBe('0.1.8')
  })

  it('is a patch above when the repo has caught up with the registry exactly', () => {
    expect(chosen('0.1.7', '0.1.7')).toBe('0.1.8')
  })
})
