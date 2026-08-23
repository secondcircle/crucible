// @vitest-environment node
//
// ⌘R groups by what a run wants from you. The classification is total over
// `RunStatus`, so every case is written out here rather than sampled.
import { describe, expect, it } from 'vitest'
import type { RunRecord, RunStatus } from '../../../shared/workflows/run'
import { bandOf, bandsOf, finishedToday, runIsWorking, runsHeadline } from './bands'

const NOW = new Date('2026-08-21T14:00:00.000Z').getTime()

function runOf(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'en42',
    workflow: 'build',
    status: 'running',
    workspacePath: '/repos/crucible',
    workspaceName: 'crucible',
    sessionId: 's1',
    inputs: {},
    nodes: [],
    createdAt: '2026-08-21T10:00:00.000Z',
    startedAt: '2026-08-21T10:00:00.000Z',
    ...overrides
  }
}

describe('which band a run is in', () => {
  it('is one of three, for every status and both waiting flags', () => {
    const cases: ReadonlyArray<[RunStatus, boolean, string]> = [
      ['running', false, 'running'],
      ['running', true, 'needsYou'],
      ['paused', false, 'needsYou'],
      ['paused', true, 'needsYou'],
      ['failed', false, 'needsYou'],
      ['failed', true, 'needsYou'],
      ['complete', false, 'done'],
      ['complete', true, 'done'],
      ['cancelled', false, 'done'],
      ['cancelled', true, 'done']
    ]
    for (const [status, waiting, band] of cases) {
      expect(bandOf(runOf({ status, waiting }))).toBe(band)
    }
  })

  it('reads an absent waiting flag as not waiting', () => {
    expect(bandOf(runOf({ status: 'running' }))).toBe('running')
  })

  // Dismissing is the user saying this row is asking for attention it no
  // longer deserves. The service only ever stamps a settled run.
  it('puts a dismissed run in Done whatever it was', () => {
    const dismissed = { dismissedAt: '2026-08-21T13:30:00.000Z' }
    expect(bandOf(runOf({ status: 'failed', ...dismissed }))).toBe('done')
    expect(bandOf(runOf({ status: 'cancelled', ...dismissed }))).toBe('done')
    expect(bandOf(runOf({ status: 'complete', ...dismissed }))).toBe('done')
  })
})

// The sidebar reads this and ⌘R reads `bandOf`, so every record goes to both:
// an edit that pulls them apart fails here rather than in the app.
describe('what counts as working on the session\'s behalf', () => {
  const STATUSES: readonly RunStatus[] = ['running', 'paused', 'complete', 'failed', 'cancelled']
  const WAITING: readonly (boolean | undefined)[] = [undefined, false, true]
  const DISMISSED: readonly (string | undefined)[] = [undefined, '2026-08-21T13:30:00.000Z']
  const EVERY_RECORD = STATUSES.flatMap((status) =>
    WAITING.flatMap((waiting) => DISMISSED.map((dismissedAt) => ({ status, waiting, dismissedAt })))
  )

  it('is true for exactly the records the runs view files under Running', () => {
    for (const shape of EVERY_RECORD) {
      const run = runOf(shape)
      expect([shape, runIsWorking(run)]).toEqual([shape, bandOf(run) === 'running'])
    }
  })

  // Spelled out as well as agreed, so the pair cannot agree on a wrong answer.
  it('is a run that is running, owed no answer and not dismissed, and nothing else', () => {
    expect(EVERY_RECORD.filter((shape) => runIsWorking(runOf(shape)))).toEqual([
      { status: 'running', waiting: undefined, dismissedAt: undefined },
      { status: 'running', waiting: false, dismissedAt: undefined }
    ])
  })
})

describe('the bands themselves', () => {
  it('come in the order running, needs you, done', () => {
    const bands = bandsOf([
      runOf({ id: 'done1', status: 'complete', endedAt: '2026-08-21T11:00:00.000Z' }),
      runOf({ id: 'need1', status: 'failed', endedAt: '2026-08-21T12:00:00.000Z' }),
      runOf({ id: 'run1' })
    ])

    expect(bands.map((band) => band.name)).toEqual(['Running', 'Needs you', 'Done'])
    expect(bands.map((band) => band.runs.length)).toEqual([1, 1, 1])
  })

  it('leaves an empty band out entirely rather than drawing a header over nothing', () => {
    const bands = bandsOf([
      runOf({ id: 'done1', status: 'cancelled', endedAt: '2026-08-21T11:00:00.000Z' })
    ])

    expect(bands.map((band) => band.band)).toEqual(['done'])
  })

  it('is nothing at all when there are no runs', () => {
    expect(bandsOf([])).toEqual([])
  })

  it('puts the newest first: by creation live, by ending once settled', () => {
    const bands = bandsOf([
      runOf({ id: 'old', createdAt: '2026-08-21T09:00:00.000Z' }),
      runOf({ id: 'new', createdAt: '2026-08-21T13:00:00.000Z' }),
      runOf({
        id: 'endedFirst',
        status: 'complete',
        createdAt: '2026-08-21T08:00:00.000Z',
        endedAt: '2026-08-21T09:00:00.000Z'
      }),
      runOf({
        id: 'endedLast',
        status: 'complete',
        createdAt: '2026-08-21T07:00:00.000Z',
        endedAt: '2026-08-21T12:00:00.000Z'
      })
    ])

    expect(bands[0]?.runs.map((run) => run.id)).toEqual(['new', 'old'])
    expect(bands[1]?.runs.map((run) => run.id)).toEqual(['endedLast', 'endedFirst'])
  })

  it('falls back to creation for a settled record that carries no ending', () => {
    const bands = bandsOf([
      runOf({ id: 'noEnd', status: 'complete', createdAt: '2026-08-21T13:00:00.000Z' }),
      runOf({
        id: 'ended',
        status: 'complete',
        createdAt: '2026-08-21T07:00:00.000Z',
        endedAt: '2026-08-21T12:00:00.000Z'
      })
    ])

    expect(bands[0]?.runs.map((run) => run.id)).toEqual(['noEnd', 'ended'])
  })
})

describe('the header line', () => {
  it('reads in the bands own words', () => {
    const line = runsHeadline(
      [
        runOf({ id: 'r1' }),
        runOf({ id: 'r2' }),
        runOf({ id: 'n1', waiting: true }),
        runOf({ id: 'n2', status: 'paused' }),
        runOf({ id: 'n3', status: 'failed', endedAt: '2026-08-21T13:00:00.000Z' }),
        runOf({ id: 'd1', status: 'complete', endedAt: '2026-08-21T13:00:00.000Z' })
      ],
      NOW
    )

    expect(line).toBe('2 running · 3 need you · 1 finished today')
  })

  it('says nothing running rather than a zero, and drops the empty segments', () => {
    const line = runsHeadline(
      [runOf({ id: 'd1', status: 'complete', endedAt: '2026-08-21T13:00:00.000Z' })],
      NOW
    )

    expect(line).toBe('nothing running · 1 finished today')
    expect(runsHeadline([], NOW)).toBe('nothing running')
  })

  it('counts one needing you in the singular', () => {
    expect(runsHeadline([runOf({ status: 'failed' })], NOW)).toBe(
      'nothing running · 1 needs you'
    )
  })

  // A dismissal is a clearing, not a finish: it leaves Needs you without
  // pretending anything was accomplished.
  it('stops counting a dismissed run as needing you, and never counts it finished', () => {
    const runs = [
      runOf({
        id: 'cleared',
        status: 'failed',
        endedAt: '2026-08-21T13:00:00.000Z',
        dismissedAt: '2026-08-21T13:30:00.000Z'
      })
    ]

    expect(finishedToday(runs, NOW)).toBe(0)
    expect(runsHeadline(runs, NOW)).toBe('nothing running')
    expect(bandsOf(runs).map((band) => band.band)).toEqual(['done'])
  })

  it('orders a dismissed run in Done by when it ended, like every other row', () => {
    const bands = bandsOf([
      runOf({
        id: 'cleared',
        status: 'failed',
        endedAt: '2026-08-21T12:00:00.000Z',
        dismissedAt: '2026-08-21T13:30:00.000Z'
      }),
      runOf({ id: 'newer', status: 'complete', endedAt: '2026-08-21T13:00:00.000Z' }),
      runOf({ id: 'older', status: 'complete', endedAt: '2026-08-21T09:00:00.000Z' })
    ])

    expect(bands[0]?.runs.map((run) => run.id)).toEqual(['newer', 'cleared', 'older'])
  })

  it('time-boxes finished today, whatever the Done band still holds', () => {
    const runs = [
      runOf({ id: 'today', status: 'complete', endedAt: '2026-08-21T13:00:00.000Z' }),
      runOf({ id: 'lastWeek', status: 'complete', endedAt: '2026-08-14T13:00:00.000Z' })
    ]

    expect(finishedToday(runs, NOW)).toBe(1)
    expect(bandsOf(runs)[0]?.runs).toHaveLength(2)
    expect(runsHeadline(runs, NOW)).toBe('nothing running · 1 finished today')
  })
})
