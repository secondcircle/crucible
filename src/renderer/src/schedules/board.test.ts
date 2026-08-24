// @vitest-environment node
//
// What the board says about runs, derived from records alone. These are the
// rules the chip's count and the board's three groups share, so they are
// checked once here rather than through the surface three times.
import { describe, expect, it } from 'vitest'
import type { RunRecord } from '../../../shared/workflows/run'
import {
  completionLine,
  lastOutcome,
  nextFireText,
  parkedNote,
  parkedRuns,
  parkedWalk,
  recentRuns,
  recentStateCell,
  reportArtifact,
  warningText
} from './board'

const HERE = '/repos/crucible'
const AWAY = '/repos/resume-site'
const NOW = Date.parse('2026-08-24T12:00:00.000Z')

function ago(hours: number): string {
  return new Date(NOW - hours * 3_600_000).toISOString()
}

function runOf(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: 'r1',
    workflow: 'triage',
    status: 'complete',
    workspacePath: HERE,
    workspaceName: 'crucible',
    scheduled: true,
    inputs: {},
    nodes: [],
    createdAt: ago(5),
    endedAt: ago(4),
    ...overrides
  }
}

const waiting = (overrides: Partial<RunRecord> = {}): RunRecord =>
  runOf({
    status: 'running',
    waiting: true,
    endedAt: undefined,
    question: { reason: 'which label?', nodeId: 'label-issues', raisedAt: ago(2) },
    ...overrides
  })

describe('what counts as parked', () => {
  it('is a session-less run waiting or failed, and nothing else', () => {
    const runs = [
      waiting({ id: 'ask' }),
      runOf({ id: 'fail', status: 'failed' }),
      // Adopted: its attention rides its session now.
      waiting({ id: 'adopted', sessionId: 's1' }),
      // Dismissed: the user cleared it.
      runOf({ id: 'gone', status: 'failed', dismissedAt: ago(1) }),
      // Clean endings never demand attention.
      runOf({ id: 'done' }),
      runOf({ id: 'stopped', status: 'cancelled' }),
      // Live and healthy: an active run is not attention-worthy by itself.
      runOf({ id: 'live', status: 'running', endedAt: undefined })
    ]

    expect(parkedRuns(runs, HERE).map((run) => run.id)).toEqual(['ask', 'fail'])
  })

  it('is newest first, by when each run stopped', () => {
    const runs = [
      waiting({ id: 'old', question: { reason: 'x', raisedAt: ago(9) } }),
      waiting({ id: 'new', question: { reason: 'y', raisedAt: ago(1) } })
    ]
    expect(parkedRuns(runs, HERE).map((run) => run.id)).toEqual(['new', 'old'])
  })

  it('walks workspaces in the order it is given them', () => {
    const runs = [
      waiting({ id: 'here' }),
      waiting({ id: 'away', workspacePath: AWAY, workspaceName: 'resume-site' })
    ]
    expect(parkedWalk(runs, [HERE, AWAY]).map((run) => run.id)).toEqual(['here', 'away'])
    expect(parkedWalk(runs, [AWAY, HERE]).map((run) => run.id)).toEqual(['away', 'here'])
    expect(parkedWalk(runs, []).map((run) => run.id)).toEqual([])
  })

  it('says why it stopped in the words the board uses', () => {
    expect(parkedNote(waiting())).toBe('asked a question')
    expect(parkedNote(runOf({ status: 'failed' }))).toBe('node failed')
    expect(
      parkedNote(
        waiting({
          nodes: [{ id: 'label-issues', status: 'stalled', parents: [], reads: [], artifacts: [] }]
        })
      )
    ).toBe('stalled')
  })
})

describe('the Recent group', () => {
  it('holds the scheduled runs of this workspace that are neither parked nor dismissed', () => {
    const runs = [
      runOf({ id: 'done' }),
      // Still going, started an hour ago: a live run's news is when it began.
      runOf({ id: 'live', status: 'running', endedAt: undefined, startedAt: ago(1) }),
      // Adopted and failed: attention rides its session, so it lands here.
      runOf({ id: 'adopted', status: 'failed', sessionId: 's1', endedAt: ago(3) }),
      waiting({ id: 'parked' }),
      runOf({ id: 'cleared', dismissedAt: ago(1) }),
      runOf({ id: 'byagent', scheduled: undefined, sessionId: 's1' }),
      runOf({ id: 'elsewhere', workspacePath: AWAY })
    ]

    expect(recentRuns(runs, HERE).map((run) => run.id)).toEqual(['live', 'adopted', 'done'])
  })

  it('says what a row shows: a report, a plain done, or a failure', () => {
    const withReport = runOf({
      nodes: [
        {
          id: 'report',
          status: 'complete',
          parents: [],
          reads: [],
          artifacts: [
            { name: 'report', path: '/state/report.md', desc: 'the report', writtenAt: ago(4) }
          ]
        }
      ]
    })
    expect(recentStateCell(withReport).text).toBe('✓ report')
    expect(recentStateCell(runOf({})).text).toBe('✓ done')
    expect(recentStateCell(runOf({ status: 'failed' })).text).toBe('✕ failed')
    expect(recentStateCell(runOf({ status: 'running', endedAt: undefined })).tone).toBe('live')
  })

  it('takes a clean line from the summary, and falls back to a status', () => {
    expect(completionLine(runOf({ outputs: { summary: 'triaged 5 issues' } }))).toBe(
      'triaged 5 issues'
    )
    expect(completionLine(runOf({}))).toBe('completed')
    expect(completionLine(runOf({ status: 'cancelled' }))).toBe('cancelled')
    expect(completionLine(runOf({ status: 'failed', error: 'node "audit" failed\nmore' }))).toBe(
      'node "audit" failed'
    )
    expect(completionLine(runOf({ status: 'running', endedAt: undefined }))).toBe('running now')
  })
})

describe('the report', () => {
  it('is the artifact declared as report, backed by the furthest-written copy', () => {
    const revised = runOf({
      nodes: [
        {
          id: 'write',
          status: 'complete',
          parents: [],
          reads: [],
          artifacts: [
            { name: 'notes', path: '/state/notes.md', desc: 'notes', writtenAt: ago(5) },
            { name: 'report', path: '/state/report.md', desc: 'the report', writtenAt: ago(5) }
          ]
        },
        {
          id: 'write·r1',
          status: 'complete',
          parents: ['write'],
          reads: [],
          artifacts: [
            { name: 'report', path: '/state/report.md', desc: 'the report', writtenAt: ago(4) }
          ]
        }
      ]
    })

    expect(reportArtifact(revised)?.writtenAt).toBe(ago(4))
    // Declared and never written is no report at all, and so is declaring none.
    expect(
      reportArtifact(
        runOf({
          nodes: [
            {
              id: 'write',
              status: 'failed',
              parents: [],
              reads: [],
              artifacts: [{ name: 'report', path: '/state/report.md', desc: 'the report' }]
            }
          ]
        })
      )
    ).toBeUndefined()
    expect(reportArtifact(runOf({}))).toBeUndefined()
  })
})

describe('the last outcome of a schedule', () => {
  it('is the most recent scheduled run of that workflow, and what became of it', () => {
    const runs = [
      runOf({ id: 'older', endedAt: ago(30) }),
      runOf({ id: 'newer', status: 'failed', endedAt: ago(3) }),
      runOf({ id: 'other', workflow: 'deps-audit', endedAt: ago(1) })
    ]

    expect(lastOutcome(runs, HERE, 'triage')).toMatchObject({ mark: '✕', text: 'failed' })
    expect(lastOutcome(runs, HERE, 'deps-audit')).toMatchObject({ mark: '✓', text: 'ok' })
    // Nothing at all when no scheduled run has ever fired.
    expect(lastOutcome(runs, HERE, 'changelog')).toBeUndefined()
    expect(lastOutcome(runs, AWAY, 'triage')).toBeUndefined()
  })

  it('reads a parked run as blocked, aged from when it stopped', () => {
    expect(lastOutcome([waiting()], HERE, 'triage')).toMatchObject({
      mark: '⚑',
      text: 'blocked',
      at: ago(2)
    })
  })
})

describe('the cells', () => {
  it('reads the next fire in the unit that still means something', () => {
    const soon = new Date(NOW + 2 * 60_000).toISOString()
    expect(nextFireText(soon, NOW)).toBe('next in 2 min')
    expect(nextFireText(new Date(NOW - 60_000).toISOString(), NOW)).toBe('due now')
    // 09:00 the next morning, read locally.
    const tomorrow = new Date(NOW)
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(9, 0, 0, 0)
    expect(nextFireText(tomorrow.toISOString(), NOW)).toBe('next 9:00 tomorrow')
    expect(nextFireText('not a time', NOW)).toBe('')
  })

  it('ages a warning and puts its message beside it', () => {
    expect(
      warningText({ kind: 'check', message: '403 from api.github.com', since: ago(3) }, NOW)
    ).toBe('⚠ check failing 3h · 403 from api.github.com')
    expect(warningText({ kind: 'kickoff', message: 'no trunk', since: ago(0) }, NOW)).toBe(
      '⚠ could not start · no trunk'
    )
    expect(warningText({ kind: 'inputs', message: 'nobody supplies them', since: ago(48) }, NOW))
      .toBe('⚠ needs inputs 2d · nobody supplies them')
  })
})
