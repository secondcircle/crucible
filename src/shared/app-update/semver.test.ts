// @vitest-environment node
//
// Version comparison decides two things that must never be guessed: whether
// the registry holds something newer than what is running, and what CI
// publishes next.
import { describe, expect, it } from 'vitest'
import { bumpPatch, compareVersions, formatVersion, isNewerVersion, parseVersion } from './semver'

describe('reading a version', () => {
  it('reads plain x.y.z', () => {
    expect(parseVersion('1.4.12')).toEqual({ major: 1, minor: 4, patch: 12 })
    expect(formatVersion({ major: 1, minor: 4, patch: 12 })).toBe('1.4.12')
  })

  it('reads nothing else, because nothing else is ever published', () => {
    for (const text of ['1.4', 'v1.4.0', '1.4.0-rc.1', '1.4.0+build', 'latest', '']) {
      expect(parseVersion(text)).toBeUndefined()
    }
  })
})

describe('comparing versions', () => {
  const order = (left: string, right: string): number =>
    compareVersions(parseVersion(left)!, parseVersion(right)!)

  it('goes major, then minor, then patch', () => {
    expect(order('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(order('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(order('1.4.3', '1.4.11')).toBeLessThan(0)
    expect(order('1.4.3', '1.4.3')).toBe(0)
  })

  it('answers no to a version it cannot read, so nothing installs on doubt', () => {
    expect(isNewerVersion('1.5.0', '1.4.0')).toBe(true)
    expect(isNewerVersion('1.4.0', '1.4.0')).toBe(false)
    expect(isNewerVersion('1.5.0-rc.1', '1.4.0')).toBe(false)
    expect(isNewerVersion('nightly', '1.4.0')).toBe(false)
  })

  it('bumps the patch and nothing else', () => {
    expect(bumpPatch({ major: 1, minor: 4, patch: 9 })).toEqual({ major: 1, minor: 4, patch: 10 })
  })
})
