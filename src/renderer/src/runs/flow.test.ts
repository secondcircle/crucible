// @vitest-environment node
//
// What the graph draws a line for, read off the record alone: the nodes each
// node ran after. The whole claim is that a line means "ran next" — never
// that one node read what another wrote — and that a node which has not
// started is drawn from the parents its record holds, as one that has.
import { describe, expect, it } from 'vitest'
import type { RunNode } from '../../../shared/workflows/run'
import { readFlow, runOrder } from './flow'

function ran(id: string, parents: string[] = [], minute = 0): RunNode {
  const at = String(minute).padStart(2, '0')
  return {
    id,
    status: 'complete',
    parents,
    reads: [],
    artifacts: [],
    startedAt: `2026-09-21T10:${at}:00.000Z`,
    endedAt: `2026-09-21T10:${at}:30.000Z`
  }
}

function ghost(id: string, parents: string[] = []): RunNode {
  return { id, status: 'pending', parents, reads: [], artifacts: [] }
}

const after = (nodes: readonly RunNode[]): Record<string, readonly string[]> => {
  const flow = readFlow(nodes)
  return Object.fromEntries(nodes.map((node) => [node.id, flow.get(node) ?? []]))
}

describe('what a node ran after', () => {
  it('draws what the node declared, once each, and nothing it only read', () => {
    // As the engine records it: the edges the node declared, whatever files
    // it took from whom. A parent named twice is one edge, a node is never
    // its own parent, and an id naming nothing is not drawn to nothing.
    const nodes = [
      ran('analyst'),
      ran('builder', ['analyst'], 1),
      ran('review-1', ['builder', 'builder'], 2),
      ran('fixer-1', ['review-1', 'fixer-1', 'nobody-by-that-name'], 3)
    ]

    expect(after(nodes)).toEqual({
      analyst: [],
      builder: ['analyst'],
      'review-1': ['builder'],
      'fixer-1': ['review-1']
    })
  })

  it('keeps a real fan-out: several nodes may declare the same predecessor', () => {
    const nodes = [
      ran('builder'),
      ran('review-code', ['builder'], 1),
      ran('review-tests', ['builder'], 1),
      ran('fixer-1', ['review-code', 'review-tests'], 2)
    ]

    expect(after(nodes)).toEqual({
      builder: [],
      'review-code': ['builder'],
      'review-tests': ['builder'],
      'fixer-1': ['review-code', 'review-tests']
    })
  })
})

describe('a node that has not started', () => {
  it('draws from the parents its record holds, so a planned fan-out stays one', () => {
    // A design run's plan: two holistic reviews off the slicer, merged by a
    // third. Neither review follows the other.
    const nodes = [
      ran('architect'),
      ghost('slicer', ['architect']),
      ghost('holistic-review-1-a', ['slicer']),
      ghost('holistic-review-1-b', ['slicer']),
      ghost('holistic-review-1', ['holistic-review-1-a', 'holistic-review-1-b'])
    ]

    expect(after(nodes)).toEqual({
      architect: [],
      slicer: ['architect'],
      'holistic-review-1-a': ['slicer'],
      'holistic-review-1-b': ['slicer'],
      'holistic-review-1': ['holistic-review-1-a', 'holistic-review-1-b']
    })
  })

  it('keeps the forecast when the run has gone on somewhere else', () => {
    // The gate is forecast under the holistic review; the run is deep inside
    // a step by now. The record still says what it says, and the layout, not
    // the flow, is what keeps the gate below the work.
    const nodes = [
      ran('analyst'),
      ran('holistic-review-1', ['analyst'], 1),
      ghost('gate-alignment-1', ['holistic-review-1']),
      ghost('gate-comments', ['gate-alignment-1']),
      ran('builder-account-shell', ['holistic-review-1'], 2),
      { ...ran('review-account-shell-1', ['builder-account-shell'], 3), status: 'running' as const }
    ]

    expect(after(nodes)).toMatchObject({
      'gate-alignment-1': ['holistic-review-1'],
      'gate-comments': ['gate-alignment-1']
    })
  })

  it('is never the parent of one that has', () => {
    // A started node declaring a parent nobody has started: the edge would
    // climb out of the planned work into work already done.
    const nodes = [ghost('later'), ran('omega', ['later'], 1)]

    expect(after(nodes)).toEqual({ later: [], omega: [] })
  })

  it('reads the same while nothing has run at all', () => {
    const nodes = [ghost('analyst'), ghost('builder', ['analyst']), ghost('gate', ['builder'])]

    expect(after(nodes)).toEqual({ analyst: [], builder: ['analyst'], gate: ['builder'] })
  })
})

describe('the order they ran', () => {
  it('walks each node after everything it ran after, and otherwise by the clock', () => {
    const nodes = [
      ran('fixer-1', ['review-1'], 4),
      ran('analyst', [], 1),
      ran('review-1', ['builder'], 3),
      ran('builder', ['analyst'], 2),
      ghost('gate-1', ['analyst'])
    ]

    expect(runOrder(nodes).map((at) => nodes[at].id)).toEqual([
      'analyst',
      'builder',
      'review-1',
      'fixer-1',
      'gate-1'
    ])
  })

  it('still walks every node of a record whose edges cycle', () => {
    const nodes = [ran('a', ['b']), ran('b', ['a']), ran('c', ['c'])]
    expect(runOrder(nodes).map((at) => nodes[at].id).sort()).toEqual(['a', 'b', 'c'])
  })
})
