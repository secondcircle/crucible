// @vitest-environment node
//
// The rules are pure, so the three that are easy to get wrong are provable
// without a document: what "not looking" means, what a run working in the
// session's name hushes, and what order Tab walks.
import { describe, expect, it } from 'vitest'
import type { SessionState, ShellSnapshot } from '../../../shared/agent/port'
import type { RunRecord, RunStatus } from '../../../shared/workflows/run'
import {
  askingCount,
  finishedAsking,
  forgetGone,
  nextAsking,
  railOrder,
  withMark,
  withoutMark
} from './needs-you'

function session(id: string, workspaceId: string): SessionState {
  return { id, workspaceId, createdAt: '2026-08-20T10:00:00.000Z', working: false, fresh: false }
}

function runOf(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'en42',
    workflow: 'build',
    status: 'running',
    workspacePath: '/repos/crucible',
    workspaceName: 'crucible',
    sessionId: 's2',
    inputs: {},
    nodes: [],
    createdAt: '2026-08-20T10:00:00.000Z',
    startedAt: '2026-08-20T10:00:00.000Z',
    ...overrides
  }
}

/** s2 finished its turn while the user was on s1, which is the unwatched case. */
function ended(runs: readonly RunRecord[]): boolean {
  return finishedAsking(
    { sessionId: 's2', outcome: 'ended' },
    { activeSessionId: 's1', windowFocused: true, runs }
  )
}

// Two workspaces, and the sessions deliberately interleaved in the snapshot so
// that rail order cannot be the snapshot's own order by accident.
const RAIL: ShellSnapshot = {
  workspaces: [
    { id: 'w1', name: 'crucible', path: '/repos/crucible' },
    { id: 'w2', name: 'splash-down', path: '/repos/splash-down' }
  ],
  activeWorkspaceId: 'w1',
  sessions: [
    session('s1', 'w1'),
    session('s3', 'w2'),
    session('s2', 'w1'),
    session('s4', 'w2')
  ],
  activeSessionId: 's1'
}

describe('what counts as unwatched', () => {
  it('marks a session nobody was looking at', () => {
    expect(ended([])).toBe(true)
  })

  it('leaves the session on screen alone while the window has focus', () => {
    expect(
      finishedAsking(
        { sessionId: 's1', outcome: 'ended' },
        { activeSessionId: 's1', windowFocused: true, runs: [] }
      )
    ).toBe(false)
  })

  it('marks even the session on screen when Crucible is behind another app', () => {
    expect(
      finishedAsking(
        { sessionId: 's1', outcome: 'ended' },
        { activeSessionId: 's1', windowFocused: false, runs: [] }
      )
    ).toBe(true)
  })
})

// The condition this file exists to pin: a turn that ended while something is
// working in the session's name is not news, whatever the turn was about.
describe('what a working run hushes', () => {
  it('says nothing at all when the session has a run working', () => {
    expect(ended([runOf({})])).toBe(false)
  })

  it('hushes a turn that never mentioned the run', () => {
    // Same verdict either way: the rule is told which session finished and
    // what it holds, never what was said in it.
    expect(ended([runOf({ workflow: 'nothing-to-do-with-it' })])).toBe(false)
  })

  it('hushes a session whose second run is parked, because the first works', () => {
    expect(ended([runOf({ id: 'aa11', waiting: true }), runOf({ id: 'bb22' })])).toBe(false)
  })

  it('marks a run parked on a check-in, which is stopped until somebody answers', () => {
    expect(ended([runOf({ waiting: true })])).toBe(true)
  })

  it('marks every run that is not working, status by status', () => {
    const stopped: readonly RunStatus[] = ['paused', 'failed', 'cancelled', 'complete']
    for (const status of stopped) {
      expect([status, ended([runOf({ status })])]).toEqual([status, true])
    }
  })

  it('marks when the only run was dismissed, though its status still reads running', () => {
    expect(ended([runOf({ dismissedAt: '2026-08-20T11:00:00.000Z' })])).toBe(true)
  })

  it('marks an errored turn over a working run: no run carries that news', () => {
    expect(
      finishedAsking(
        { sessionId: 's2', outcome: 'errored' },
        { activeSessionId: 's1', windowFocused: true, runs: [runOf({})] }
      )
    ).toBe(true)
  })

  // Being watched beats the rest: the error override is over the hush, never
  // over the user having been there to see it.
  it('leaves a watched session alone however its turn ended', () => {
    expect(
      finishedAsking(
        { sessionId: 's1', outcome: 'errored' },
        { activeSessionId: 's1', windowFocused: true, runs: [runOf({ sessionId: 's1' })] }
      )
    ).toBe(false)
  })

  it('never lets another session\'s working run silence this one', () => {
    expect(ended([runOf({ sessionId: 's9' })])).toBe(true)
  })

  it('lets an unattended run silence nothing at all', () => {
    expect(ended([runOf({ sessionId: undefined })])).toBe(true)
  })
})

describe('rail order', () => {
  it('is workspace by workspace, top to bottom, as the sidebar lists them', () => {
    expect(railOrder(RAIL).map((found) => found.id)).toEqual(['s1', 's2', 's3', 's4'])
  })

  it('takes the topmost asking, whichever workspace it is in', () => {
    expect(nextAsking(RAIL, new Set(['s4', 's2']))?.id).toBe('s2')
  })

  it('crosses into the next workspace when this one is clear', () => {
    expect(nextAsking(RAIL, new Set(['s4']))?.id).toBe('s4')
  })

  it('finds nothing when nothing is asking', () => {
    expect(nextAsking(RAIL, new Set())).toBeUndefined()
  })
})

describe('the count', () => {
  it('is what the dock badge carries, across every workspace', () => {
    expect(askingCount(RAIL.sessions, new Set(['s1', 's4']))).toBe(2)
  })
})

describe('marks', () => {
  it('go on and come off without disturbing the rest', () => {
    const marked = withMark(withMark(new Set<string>(), 's1'), 's2')
    expect([...withoutMark(marked, 's1')]).toEqual(['s2'])
  })

  it('are the same set when nothing changed, so React re-renders nothing', () => {
    const marked = withMark(new Set<string>(), 's1')
    expect(withMark(marked, 's1')).toBe(marked)
    expect(withoutMark(marked, 's9')).toBe(marked)
  })

  it('go with the session when it leaves the sidebar', () => {
    const marked = new Set(['s1', 's2'])
    expect([...forgetGone(marked, [session('s2', 'w1')])]).toEqual(['s2'])
  })
})
