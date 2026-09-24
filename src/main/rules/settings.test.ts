// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readAllowedJudges, readJudgeCredential } from './settings'

const homes: string[] = []
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function home(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'crucible-home-'))
  homes.push(dir)
  mkdirSync(join(dir, '.crucible'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, '.crucible', name), text)
  return dir
}

describe('the judge settings', () => {
  it('reads the credential in either shape a shell would write it', () => {
    expect(readJudgeCredential(home({ 'typesafe.env': 'export TYPESAFE_API_KEY=ts_abc\n' }))).toBe('ts_abc')
    expect(readJudgeCredential(home({ 'typesafe.env': '# key\nTYPESAFE_API_KEY="ts_q"\n' }))).toBe('ts_q')
    expect(readJudgeCredential(home({}))).toBeUndefined()
  })

  it('allows a workspace only the judges the file names for it', () => {
    const dir = home({ 'judges.json': JSON.stringify({ '/repos/app': ['jev-1.13.0'] }) })
    expect(readAllowedJudges(dir, '/repos/app')).toEqual(['jev-1.13.0'])
    expect(readAllowedJudges(dir, '/repos/other')).toEqual([])
    expect(readAllowedJudges(home({ 'judges.json': '{' }), '/repos/app')).toEqual([])
  })
})
