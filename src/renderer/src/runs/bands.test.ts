// @vitest-environment node
//
// ⌘R groups by what a run wants from you. The classification is total over
// `RunStatus`, so every case is written out here rather than sampled.
import { describe, expect, it } from 'vitest'
import type { RunRecord, RunStatus } from '../../../shared/workflows/run'
import { bandOf, bandsOf, finishedToday, runsHeadline } from './bands'

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
