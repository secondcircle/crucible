// @vitest-environment node
//
// Step blocks, read from node ids alone: a workflow declares nothing to get
// the outline, so the reading has to know a step from a loop and from a run
// of unrelated nodes that happen to share a shape.
import { describe, expect, it } from 'vitest'
import type { RunNode } from '../../../shared/workflows/run'
import { readSteps, stepName } from './steps'

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

/** The chain a build records: each node declares the one before it. */
function chain(ids: readonly string[]): RunNode[] {
  return ids.map((id, at) => ran(id, at === 0 ? [] : [ids[at - 1]], at))
}

const blocksOf = (nodes: readonly RunNode[]): Record<string, string[]> =>
  Object.fromEntries(
    readSteps(nodes).map((block) => [block.name, block.members.map((at) => nodes[at].id)])
  )

describe('the step an id names', () => {
  it('is what is left of the id once its role and its round come off', () => {
    expect(stepName('builder-account-shell')).toBe('account-shell')
    expect(stepName('review-account-shell-1')).toBe('account-shell')
    expect(stepName('fixer-browser-suite-runner-12')).toBe('browser-suite-runner')
    // A revision is another record of the same node, so it is the same step.
    expect(stepName('review-account-shell-1\u00b7r1')).toBe('account-shell')
  })

  it('is nothing at all for an id that names only a role', () => {
    expect(stepName('analyst')).toBeUndefined()
    expect(stepName('review-1')).toBeUndefined()
    expect(stepName('builder')).toBeUndefined()
    expect(stepName('-1')).toBeUndefined()
  })
})

describe('the blocks a run holds', () => {
  it('boxes each step\u2019s stretch, in the order the steps ran', () => {
    const nodes = chain([
      'analyst',
      'slicer',
      'builder-browser-suite-runner',
      'review-browser-suite-runner-1',
      'fixer-browser-suite-runner-1',
      'review-browser-suite-runner-2',
      'builder-account-shell',
      'review-account-shell-1'
    ])

    expect(readSteps(nodes).map((block) => block.name)).toEqual([
      'browser-suite-runner',
      'account-shell'
    ])
    expect(blocksOf(nodes)).toEqual({
      'browser-suite-runner': [
        'builder-browser-suite-runner',
        'review-browser-suite-runner-1',
        'fixer-browser-suite-runner-1',
        'review-browser-suite-runner-2'
      ],
      'account-shell': ['builder-account-shell', 'review-account-shell-1']
    })
  })

  it('takes a revision into the block of the node it revises', () => {
    const nodes = chain([
      'builder-account-shell',
      'review-account-shell-1',
      'review-account-shell-1\u00b7r1'
    ])

    expect(blocksOf(nodes)['account-shell']).toHaveLength(3)
  })

  it('reads a loop as a loop, not as a step', () => {
    // Rounds of one review share a name, and it is the review's own, not a
    // piece of work's: one role, so no outline.
    expect(blocksOf(chain(['holistic-review-1', 'holistic-review-2']))).toEqual({})
    expect(blocksOf(chain(['review-1', 'fixer-1', 'review-2']))).toEqual({})
  })

  it('leaves a lone node, and nodes that only look alike, outside any block', () => {
    // One node about a step is a node, not a stretch; and the gate nodes
    // share a role rather than a step, which is the other way round.
    expect(blocksOf(chain(['slicer', 'builder-account-shell', 'gate-alignment-1']))).toEqual({})
    expect(blocksOf(chain(['gate-alignment-1', 'gate-comments', 'gate-verdict-1']))).toEqual({})
  })

  it('breaks a block where the run left the step and starts a new one on return', () => {
    const nodes = chain([
      'builder-shell',
      'review-shell-1',
      'holistic-review-1',
      'builder-pane',
      'review-pane-1'
    ])

    expect(readSteps(nodes).map((block) => block.name)).toEqual(['shell', 'pane'])
  })

  it('reads the blocks in the order the run walked, not the order the record holds', () => {
    // A plan's ghosts sit early in the record; the reading follows the run.
    const nodes = [
      ran('analyst', [], 0),
      { ...ran('gate-comments', ['gate-alignment-1']), status: 'pending' as const },
      ran('builder-account-shell', ['analyst'], 2),
      ran('review-account-shell-1', ['builder-account-shell'], 3)
    ]

    expect(blocksOf(nodes)).toEqual({
      'account-shell': ['builder-account-shell', 'review-account-shell-1']
    })
  })
})
