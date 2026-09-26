// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { RunRecord } from './run'
import { withChangedRuns } from './service'

function runOf(id: string, createdAt: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    workflow: 'build',
    status: 'running',
    workspacePath: '/repos/crucible',
    workspaceName: 'crucible',
    inputs: {},
    nodes: [],
    createdAt,
    ...overrides
  }
}

describe('folding changed records into a snapshot', () => {
  const held = [
    runOf('cc33', '2026-08-20T12:00:00.000Z'),
    runOf('bb22', '2026-08-20T11:00:00.000Z'),
    runOf('aa11', '2026-08-20T10:00:00.000Z')
  ]

  it('puts each changed record in place of its older self and leaves the rest alone', () => {
    const moved = runOf('bb22', '2026-08-20T11:00:00.000Z', { status: 'complete' })
    const next = withChangedRuns(held, [moved])
    expect(next.map((run) => run.id)).toEqual(['cc33', 'bb22', 'aa11'])
    expect(next[1]).toBe(moved)
    expect(next[0]).toBe(held[0])
    expect(next[2]).toBe(held[2])
  })

  it('adds a record it did not hold, newest first', () => {
    const started = runOf('dd44', '2026-08-20T13:00:00.000Z')
    const between = runOf('bc23', '2026-08-20T11:30:00.000Z')
    const next = withChangedRuns(held, [between, started])
    expect(next.map((run) => run.id)).toEqual(['dd44', 'cc33', 'bc23', 'bb22', 'aa11'])
  })

  it('answers the same snapshot when nothing changed', () => {
    expect(withChangedRuns(held, [])).toBe(held)
  })

  it('never drops a record the change did not name', () => {
    expect(withChangedRuns(held, [runOf('cc33', '2026-08-20T12:00:00.000Z')])).toHaveLength(3)
  })
})
