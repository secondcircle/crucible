// @vitest-environment node
//
// A jump belongs to one session: what the shape holds, and the one line each
// state says.
import { describe, expect, it } from 'vitest'
import {
  jumpBusy,
  jumpCancellable,
  jumpNote,
  jumpOf,
  summaryFailure,
  withJump,
  withoutJump,
  type Jumps
} from './jumps'

const SUMMARIZING = { kind: 'summarizing', ref: 'n2' } as const

describe('what a session holds', () => {
  it('is its own jump and no other session\'s', () => {
    const jumps: Jumps = withJump({}, 's1', SUMMARIZING)

    expect(jumpOf(jumps, 's1')).toEqual(SUMMARIZING)
    expect(jumpOf(jumps, 's2')).toBeUndefined()
    expect(jumpOf(jumps, undefined)).toBeUndefined()
  })

  it('leaves the others exactly where they were when one is taken out', () => {
    const jumps = withJump(withJump({}, 's1', SUMMARIZING), 's2', {
      kind: 'failed',
      ref: 'n7',
      message: 'Opus is overloaded'
    })

    const after = withoutJump(jumps, 's1')

    expect(jumpOf(after, 's1')).toBeUndefined()
    expect(jumpOf(after, 's2')).toEqual({
      kind: 'failed',
      ref: 'n7',
      message: 'Opus is overloaded'
    })
    // Nothing to remove changes nothing at all, so no render is provoked.
    expect(withoutJump(after, 's1')).toBe(after)
  })
})

describe('what a state means', () => {
  it('is busy for everything but a failure, which is over', () => {
    expect(jumpBusy(undefined)).toBe(false)
    expect(jumpBusy({ kind: 'jumping', ref: 'n1' })).toBe(true)
    expect(jumpBusy(SUMMARIZING)).toBe(true)
    expect(jumpBusy({ kind: 'cancelling', ref: 'n1' })).toBe(true)
    expect(jumpBusy({ kind: 'failed', ref: 'n1', message: 'no' })).toBe(false)
  })

  it('is cancellable only while a summary is genuinely running', () => {
    expect(jumpCancellable(SUMMARIZING)).toBe(true)
    expect(
      jumpCancellable({
        kind: 'retrying',
        ref: 'n2',
        attempt: 2,
        maxAttempts: 3,
        message: 'Overloaded'
      })
    ).toBe(true)
    // A plain jump has no call to abort, and asking twice is not an escalation.
    expect(jumpCancellable({ kind: 'jumping', ref: 'n1' })).toBe(false)
    expect(jumpCancellable({ kind: 'cancelling', ref: 'n1' })).toBe(false)
    expect(jumpCancellable(undefined)).toBe(false)
  })
})

describe('the line the overlay shows', () => {
  it('narrates the wait, the retries, the cancel and the failure', () => {
    expect(jumpNote({ kind: 'jumping', ref: 'n1' })).toBe('Jumping…')
    expect(jumpNote(SUMMARIZING)).toBe('Summarizing the branch you are leaving…')
    expect(
      jumpNote({
        kind: 'retrying',
        ref: 'n2',
        attempt: 2,
        maxAttempts: 3,
        message: 'Overloaded'
      })
    ).toBe('Overloaded — retrying (2 of 3)')
    expect(jumpNote({ kind: 'cancelling', ref: 'n2' })).toBe('Cancelling…')
    expect(jumpNote({ kind: 'failed', ref: 'n2', message: 'Opus is overloaded' })).toBe(
      'Summary failed — Opus is overloaded. Nothing moved; press s to try again.'
    )
  })

  it('says the failure in the same words wherever it is shown', () => {
    expect(summaryFailure('Opus is overloaded')).toBe(
      jumpNote({ kind: 'failed', ref: 'n2', message: 'Opus is overloaded' })
    )
  })
})
