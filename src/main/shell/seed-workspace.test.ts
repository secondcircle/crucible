// @vitest-environment node
//
// WS-7 is what lets an agent-driven check reach a chattable state without an OS
// dialog, so what it accepts and what it ignores are both worth pinning: a real
// directory is honored, and anything else leaves the launch as it would have
// been rather than failing it.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedWorkspacePath } from './seed-workspace'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'crucible-seed-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('the workspace a launch is told to open', () => {
  it('is the folder the variable names, absolute', () => {
    expect(seedWorkspacePath(directory)).toBe(resolve(directory))
  })

  it('is nothing when the variable is unset or blank', () => {
    expect(seedWorkspacePath(undefined)).toBeUndefined()
    expect(seedWorkspacePath('   ')).toBeUndefined()
  })

  it('is nothing when what it names is not a directory', () => {
    const file = join(directory, 'a-file')
    writeFileSync(file, 'x')

    expect(seedWorkspacePath(file)).toBeUndefined()
    expect(seedWorkspacePath(join(directory, 'not-here'))).toBeUndefined()
  })
})
