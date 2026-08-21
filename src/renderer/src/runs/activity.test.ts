import { describe, expect, it } from 'vitest'
import type { RunRecord } from '../../../shared/workflows/run'
import { runActivity } from './activity'

// The arithmetic behind the rail's teal mark, on its own: which run's age the
// counter shows, whether anything is still moving, and which runs the rail
// has no business marking at all.

function runOf(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: 'en42',
    workflow: 'build',
    status: 'running',
    workspacePath: '/repos/crucible',
    workspaceName: 'crucible',
    sessionId: 's1',
    inputs: {},
    nodes: [],
    createdAt: '2026-08-21T09:00:00.000Z',
    startedAt: '2026-08-21T09:00:00.000Z',
    ...overrides
  }
}

describe('run activity', () => {
  it('marks the session a live run belongs to', () => {
    expect(runActivity([runOf({})])).toEqual({
      s1: { since: '2026-08-21T09:00:00.000Z', moving: true }
    })
  })

  it('takes the oldest live run of the session, whichever order they arrive in', () => {
    const older = runOf({ id: 'aa11', startedAt: '2026-08-21T08:30:00.000Z' })
    const newer = runOf({ id: 'bb22', startedAt: '2026-08-21T09:45:00.000Z' })

    expect(runActivity([newer, older]).s1?.since).toBe('2026-08-21T08:30:00.000Z')
    expect(runActivity([older, newer]).s1?.since).toBe('2026-08-21T08:30:00.000Z')
  })

  it('is still moving while any one of the live runs is running', () => {
    const activity = runActivity([
      runOf({ id: 'aa11', status: 'paused' }),
      runOf({ id: 'bb22', status: 'running' })
    ])

    expect(activity.s1?.moving).toBe(true)
  })

  it('holds still when every live run is paused, and keeps the mark', () => {
    const activity = runActivity([
      runOf({ id: 'aa11', status: 'paused', startedAt: '2026-08-21T08:19:00.000Z' }),
      runOf({ id: 'bb22', status: 'paused' })
    ])

    expect(activity.s1).toEqual({ since: '2026-08-21T08:19:00.000Z', moving: false })
  })

  it('falls back to when the record was created, for a run yet to start', () => {
    const activity = runActivity([
      runOf({ startedAt: undefined, createdAt: '2026-08-21T09:12:00.000Z' })
    ])

    expect(activity.s1?.since).toBe('2026-08-21T09:12:00.000Z')
  })

  it('marks nobody for an unattended run', () => {
    expect(runActivity([runOf({ sessionId: undefined })])).toEqual({})
  })

  it('marks nobody for a run that has left liveness', () => {
    expect(
      runActivity([
        runOf({ id: 'aa11', status: 'complete' }),
        runOf({ id: 'bb22', status: 'failed' }),
        runOf({ id: 'cc33', status: 'cancelled' })
      ])
    ).toEqual({})
  })

  it('keeps every session apart, across workspaces', () => {
    const activity = runActivity([
      runOf({}),
      runOf({
        id: 'zz11',
        sessionId: 's9',
        status: 'paused',
        workspaceName: 'resume-site',
        workspacePath: '/repos/resume-site',
        startedAt: '2026-08-21T07:00:00.000Z'
      })
    ])

    expect(activity).toEqual({
      s1: { since: '2026-08-21T09:00:00.000Z', moving: true },
      s9: { since: '2026-08-21T07:00:00.000Z', moving: false }
    })
  })

  it('is empty when nothing is running at all', () => {
    expect(runActivity([])).toEqual({})
  })
})
