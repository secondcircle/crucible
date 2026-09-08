import { describe, expect, it } from 'vitest'
import type { LiveMonitor } from '../../../shared/monitors/monitor'
import { elapsedFraction, inlineOutput, monitorActivity, waitedFor } from './activity'

// The arithmetic the rail and the strip are drawn from, without a DOM.

const AT = Date.parse('2026-09-08T10:10:00.000Z')

function monitorOf(overrides: Partial<LiveMonitor> = {}): LiveMonitor {
  return {
    id: 'm-1f3a',
    sessionId: 's1',
    description: 'CI on PR #482 to finish',
    reason: 'so I can read the log',
    command: 'gh pr checks 482',
    cwd: '/repos/crucible',
    intervalMs: 30_000,
    timeoutMs: 30 * 60_000,
    setAt: '2026-09-08T10:06:00.000Z',
    checks: 8,
    ...overrides
  }
}

describe('what the rail reads', () => {
  it('holds nothing for a session with no live monitor', () => {
    expect(monitorActivity({ monitors: [] })).toEqual({})
  })

  it('shows the longest wait of a session, not the newest', () => {
    const activity = monitorActivity({
      monitors: [
        monitorOf({ setAt: '2026-09-08T10:06:00.000Z' }),
        monitorOf({ id: 'm-2222', setAt: '2026-09-08T09:59:00.000Z' }),
        monitorOf({ id: 'm-3333', setAt: '2026-09-08T10:08:00.000Z' })
      ]
    })
    expect(activity.s1).toEqual({ since: '2026-09-08T09:59:00.000Z' })
  })

  it('keeps each session\u2019s wait to itself', () => {
    const activity = monitorActivity({
      monitors: [monitorOf(), monitorOf({ id: 'm-2222', sessionId: 's2' })]
    })
    expect(Object.keys(activity).sort()).toEqual(['s1', 's2'])
  })

  it('lets one unreadable stamp lose rather than own the counter', () => {
    const activity = monitorActivity({
      monitors: [monitorOf({ setAt: 'not a date' }), monitorOf({ id: 'm-2222' })]
    })
    expect(activity.s1.since).toBe('2026-09-08T10:06:00.000Z')
  })
})

describe('the units every monitor surface shares', () => {
  it('is the chips\u2019 shorthand, from one function', () => {
    expect(waitedFor('2026-09-08T10:06:00.000Z', AT)).toBe('4m')
    expect(waitedFor('nonsense', AT)).toBe('')
    // A stamp in the future is not a negative wait.
    expect(waitedFor('2026-09-08T10:20:00.000Z', AT)).toBe('0s')
  })
})

describe('the hairline', () => {
  it('is the elapsed share of the timeout', () => {
    expect(elapsedFraction(monitorOf(), AT)).toBeCloseTo(4 / 30, 5)
  })

  it('never runs past its end or before its start', () => {
    expect(elapsedFraction(monitorOf({ timeoutMs: 60_000 }), AT)).toBe(1)
    expect(elapsedFraction(monitorOf(), Date.parse('2026-09-08T10:00:00.000Z'))).toBe(0)
  })
})

describe('the chip\u2019s inline output', () => {
  it('is the first line that says anything', () => {
    expect(
      inlineOutput(
        monitorOf({
          last: {
            at: '2026-09-08T10:09:00.000Z',
            output: { text: '\n\nin_progress\nqueued\n', truncated: false },
            result: { kind: 'exited', exitCode: 1 }
          }
        })
      )
    ).toBe('in_progress')
  })

  it('is nothing at all before the first check has finished', () => {
    expect(inlineOutput(monitorOf())).toBeUndefined()
  })
})
