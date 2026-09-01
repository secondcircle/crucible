// @vitest-environment node
//
// The one part of this feature whose correctness depends on a format nobody
// here controls, driven from captured output. Nothing is spawned: the reader is
// a pure function of what a process did.
//
// The two connected fixtures were written by hand rather than captured, because
// a working credential needs a paid key; one that turns out wrong reads as
// `unreadable`, never as a figure nobody reported.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { REDACTION } from '../../shared/workspace/research'
import type { ProcessOutcome } from './research-processes'
import { readResearchStatus, refusalMessage } from './research-status'

function fixture(name: string): string {
  return readFileSync(new URL(`./research-fixtures/${name}`, import.meta.url), 'utf8')
}

/** What the CLI did: its output on stdout, and the code it exited with. */
function exited(name: string, code: number): ProcessOutcome {
  return { kind: 'exited', code, stdout: fixture(name), stderr: '' }
}

describe('what one reading of the research CLI found', () => {
  it('reads a CLI with no credential as installed and signed out', () => {
    expect(readResearchStatus(exited('doctor-not-connected.json', 1))).toEqual({
      kind: 'signedOut',
      version: '1.23.3'
    })
  })

  it('reads a connected CLI with its version and its credit figure', () => {
    expect(readResearchStatus(exited('doctor-connected.json', 0))).toEqual({
      kind: 'signedIn',
      version: '1.23.3',
      credits: 12_500
    })
  })

  it('keeps none left as the number it is', () => {
    expect(readResearchStatus(exited('doctor-connected-no-credits-left.json', 1))).toEqual({
      kind: 'signedIn',
      version: '1.23.3',
      credits: 0
    })
  })

  it('leaves credits out where the CLI reported no figure at all', () => {
    const status = readResearchStatus(exited('doctor-connected-key-refused.json', 1))

    // The credential is stored, so the CLI is connected; the account behind it
    // answered nothing, so there is no figure to show and none is invented.
    expect(status).toEqual({ kind: 'signedIn', version: '1.23.3' })
    expect('credits' in status).toBe(false)
  })

  it('takes recognizable output whatever the exit code was', () => {
    // Both captures exited non-zero — the CLI exits 1 for any failing check,
    // being signed out among them — and both are perfectly readable.
    expect(readResearchStatus(exited('doctor-not-connected.json', 1)).kind).toBe('signedOut')
    expect(readResearchStatus(exited('doctor-not-connected.json', 0)).kind).toBe('signedOut')
    expect(readResearchStatus(exited('doctor-connected.json', 7)).kind).toBe('signedIn')
  })
})

describe('a reading that could not be made', () => {
  it('calls a missing binary not installed, and nothing else ever is', () => {
    expect(readResearchStatus({ kind: 'noBinary' })).toEqual({ kind: 'notInstalled' })
  })

  it('calls every other failure unreadable, claiming neither presence nor absence', () => {
    const failures: readonly ProcessOutcome[] = [
      { kind: 'timedOut', stdout: '', stderr: '' },
      { kind: 'cancelled' },
      { kind: 'failed', reason: 'spawn EACCES' },
      { kind: 'exited', code: 127, stdout: '', stderr: '' }
    ]

    for (const outcome of failures) {
      expect(readResearchStatus(outcome).kind).toBe('unreadable')
    }
  })

  it('carries the reason each failure came with', () => {
    expect(readResearchStatus({ kind: 'failed', reason: 'spawn EACCES' })).toEqual({
      kind: 'unreadable',
      reason: 'spawn EACCES'
    })
    expect(readResearchStatus({ kind: 'timedOut', stdout: '', stderr: '' })).toMatchObject({
      reason: expect.stringContaining('in time')
    })
    expect(
      readResearchStatus({ kind: 'exited', code: 2, stdout: '', stderr: '' })
    ).toMatchObject({ reason: expect.stringContaining('code 2') })
  })

  it('refuses to guess at output it does not recognize', () => {
    const prose = readResearchStatus({
      kind: 'exited',
      code: 0,
      stdout: fixture('status-prose.txt'),
      stderr: ''
    })

    expect(prose.kind).toBe('unreadable')
    // The CLI's own words, with the terminal colours taken out of them.
    expect(prose.kind === 'unreadable' ? prose.reason : '').toContain('Authenticated')
    expect(prose.kind === 'unreadable' ? prose.reason : '').not.toContain('\u001b')
  })

  it('says so plainly where the JSON is well formed but says nothing known', () => {
    expect(
      readResearchStatus({ kind: 'exited', code: 0, stdout: '{"checks":[]}', stderr: '' }).kind
    ).toBe('unreadable')
    expect(
      readResearchStatus({ kind: 'exited', code: 0, stdout: '{"other":true}', stderr: '' }).kind
    ).toBe('unreadable')
  })
})

describe('what leaves the reader', () => {
  it('redacts anything key-shaped before it can reach a row', () => {
    const status = readResearchStatus({
      kind: 'exited',
      code: 1,
      stdout: 'no key like fc-9f2a7b0c4d5e6f708192a3b4c5d6e7f8 worked',
      stderr: ''
    })

    expect(status.kind === 'unreadable' ? status.reason : '').toContain(REDACTION)
    expect(status.kind === 'unreadable' ? status.reason : '').not.toContain('9f2a7b0c')
  })

  it('redacts a refusal too, and keeps the CLI’s own sentence', () => {
    const refused = refusalMessage({
      kind: 'exited',
      code: 1,
      stdout: '',
      stderr: 'Error: Invalid API key format. API keys should start with "fc-"\n'
    })

    expect(refused).toBe('Error: Invalid API key format. API keys should start with "fc-"')

    expect(
      refusalMessage({
        kind: 'exited',
        code: 1,
        stdout: 'fc-9f2a7b0c4d5e6f708192a3b4c5d6e7f8 was refused',
        stderr: ''
      })
    ).toBe(`${REDACTION} was refused`)
  })

  it('has words for every ending a connect or a log-out can have', () => {
    expect(refusalMessage({ kind: 'noBinary' })).toContain('not installed')
    expect(refusalMessage({ kind: 'timedOut', stdout: '', stderr: '' })).toContain('in time')
    expect(refusalMessage({ kind: 'failed', reason: 'spawn EACCES' })).toBe('spawn EACCES')
    expect(refusalMessage({ kind: 'exited', code: 3, stdout: '', stderr: '' })).toContain('3')
  })
})
