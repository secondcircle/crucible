// @vitest-environment node
//
// The graph's geometry, which is the whole claim: the same record draws the
// same picture, parents sit above their children, independent subtrees stand
// apart and nothing overlaps. All of it is a pure function of the record, so
// none of it needs a window.
import { describe, expect, it } from 'vitest'
import type { RunNode } from '../../../shared/workflows/run'
import { cardFace, edgeState, graphCount, layOutGraph } from './graph'

function nodeOf(id: string, parents: string[] = [], overrides: Partial<RunNode> = {}): RunNode {
  return {
    id,
    status: 'complete',
    parents,
    reads: [],
    artifacts: [],
    startedAt: '2026-08-21T10:00:00.000Z',
    endedAt: '2026-08-21T10:12:00.000Z',
    ...overrides
  }
}

/** The line the build workflow draws, fan-out and fan-in included. */
const BUILD: RunNode[] = [
  nodeOf('planner'),
  nodeOf('builder', ['planner']),
  nodeOf('review-code', ['builder']),
  nodeOf('review-tests', ['builder']),
  nodeOf('review-docs', ['builder']),
  nodeOf('fixer-1', ['review-code', 'review-tests', 'review-docs'])
]

const card = (layout: ReturnType<typeof layOutGraph>, id: string) => {
  const found = layout.cards.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`no card for ${id}`)
  return found
}

const centre = (layout: ReturnType<typeof layOutGraph>, id: string): number =>
  card(layout, id).x + layout.cardWidth / 2

describe('the run graph layout', () => {
  it('gives every node exactly one card and every parent edge one line', () => {
    const layout = layOutGraph(BUILD)

    expect(layout.cards.map((one) => one.id)).toEqual(BUILD.map((node) => node.id))
    expect(layout.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual([
      'planner->builder',
      'builder->review-code',
      'builder->review-tests',
      'builder->review-docs',
      'review-code->fixer-1',
      'review-tests->fixer-1',
      'review-docs->fixer-1'
    ])
    for (const edge of layout.edges) expect(edge.d).toMatch(/^M[-\d.]+,[-\d.]+/)
  })

  it('skips a parent id the record does not name, and never draws to nothing', () => {
    const layout = layOutGraph([nodeOf('work', ['ghost-that-was-pruned']), nodeOf('after', ['work'])])

    expect(layout.cards).toHaveLength(2)
    expect(layout.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual(['work->after'])
    // With nothing above it, the node with the dangling parent is a root.
    expect(card(layout, 'work').layer).toBe(0)
  })

  it('puts every parent in a strictly shallower layer, so edges descend the page', () => {
    const layout = layOutGraph([
      ...BUILD,
      // A revision reaching back to a node several rounds above it.
      nodeOf('review-code·r1', ['fixer-1', 'review-code'])
    ])

    for (const node of layout.cards) {
      for (const parent of node.node.parents) {
        const above = layout.cards.find((candidate) => candidate.id === parent)
        if (above === undefined) continue
        expect(above.layer, `${parent} above ${node.id}`).toBeLessThan(node.layer)
        expect(above.y).toBeLessThan(node.y)
      }
    }
    // Longest path, not shortest: the revision sits below the fixer, not
    // beside it just because one of its parents is two layers up.
    expect(card(layout, 'review-code·r1').layer).toBe(card(layout, 'fixer-1').layer + 1)
  })

  it('sits a fan-out adjacent under its parent, and a fan-in under their spread', () => {
    const layout = layOutGraph(BUILD)
    const [code, tests, docs] = ['review-code', 'review-tests', 'review-docs'].map((id) =>
      card(layout, id)
    )

    // One layer, in record order, evenly spaced and touching nothing else.
    expect(new Set([code.layer, tests.layer, docs.layer])).toEqual(new Set([2]))
    expect(code.x).toBeLessThan(tests.x)
    expect(tests.x).toBeLessThan(docs.x)
    expect(tests.x - code.x).toBe(docs.x - tests.x)
    // Centred under the card they all came from, and the fan-in centred back
    // under the spread of the three.
    expect(centre(layout, 'review-tests')).toBeCloseTo(centre(layout, 'builder'), 5)
    expect(centre(layout, 'fixer-1')).toBeCloseTo(centre(layout, 'review-tests'), 5)
  })

  it('lets an unattached node start its own column, side by side with the rest', () => {
    const layout = layOutGraph([
      ...BUILD,
      // Declares nothing and reads nothing anyone produced: a stray root, and
      // the picture says so rather than inventing an edge.
      nodeOf('docs-writer'),
      nodeOf('docs-review', ['docs-writer'])
    ])

    expect(card(layout, 'docs-writer').layer).toBe(0)
    expect(card(layout, 'docs-writer').y).toBe(card(layout, 'planner').y)
    // The whole second subtree stands to the right of the whole first one.
    const first = Math.max(
      ...BUILD.map((node) => card(layout, node.id).x + layout.cardWidth)
    )
    expect(card(layout, 'docs-writer').x).toBeGreaterThanOrEqual(first)
    expect(card(layout, 'docs-review').x).toBeGreaterThanOrEqual(first)
  })

  it('overlaps no two cards and keeps the gaps even', () => {
    const layout = layOutGraph([
      ...BUILD,
      nodeOf('gate-alignment-1', ['fixer-1']),
      nodeOf('gate-comments-1', ['gate-alignment-1']),
      nodeOf('gate-verdict-1', ['gate-alignment-1', 'gate-comments-1']),
      nodeOf('loose-end')
    ])

    for (const one of layout.cards) {
      for (const other of layout.cards) {
        if (one === other) continue
        const apart =
          one.x + layout.cardWidth <= other.x ||
          other.x + layout.cardWidth <= one.x ||
          one.y + layout.cardHeight <= other.y ||
          other.y + layout.cardHeight <= one.y
        expect(apart, `${one.id} overlaps ${other.id}`).toBe(true)
      }
    }
    // One layer height for the whole drawing.
    const rows = [...new Set(layout.cards.map((one) => one.y))].sort((a, b) => a - b)
    const steps = rows.slice(1).map((y, at) => y - rows[at])
    expect(new Set(steps).size).toBe(1)
  })

  it('draws every card wide enough for its longest id, never narrower than the floor', () => {
    const short = layOutGraph([nodeOf('work')])
    const long = layOutGraph([nodeOf('work'), nodeOf('gate-alignment-12', ['work'])])
    const longer = layOutGraph([nodeOf('work'), nodeOf('gate-alignment-12·r1', ['work'])])

    expect(short.cardWidth).toBe(168)
    // The card grows with the id it has to render whole, and the same width
    // goes to every card in the graph.
    expect(long.cardWidth).toBeGreaterThan(short.cardWidth)
    expect(longer.cardWidth).toBeGreaterThan(long.cardWidth)
    expect(new Set(long.cards.map(() => long.cardWidth)).size).toBe(1)
  })

  it('bows an edge that crosses a layer around the cards between, not through them', () => {
    const layout = layOutGraph([
      nodeOf('planner'),
      nodeOf('builder', ['planner']),
      nodeOf('review-1', ['builder']),
      nodeOf('fixer-1', ['review-1']),
      // Two layers down from its base, so the line has cards to get past.
      nodeOf('review-1·r1', ['fixer-1', 'builder'])
    ])
    const bowed = layout.edges.find((edge) => edge.from === 'builder' && edge.to === 'review-1·r1')

    expect(bowed).toBeDefined()
    // The long run of the line is a straight vertical segment, and it is
    // clear of every card it passes.
    const lane = Number(/L([-\d.]+),/.exec(bowed?.d ?? '')?.[1])
    expect(Number.isNaN(lane)).toBe(false)
    const passed = layout.cards.filter(
      (one) => one.id === 'review-1' || one.id === 'fixer-1'
    )
    for (const one of passed) {
      expect(lane < one.x || lane > one.x + layout.cardWidth, `lane through ${one.id}`).toBe(true)
    }
    // Whatever the bow costs in room, the canvas holds it.
    expect(lane).toBeGreaterThan(0)
    expect(lane).toBeLessThan(layout.width)
  })

  it('draws the identical picture twice, and holds still as the record grows', () => {
    const once = layOutGraph(BUILD)
    const again = layOutGraph(BUILD.map((node) => ({ ...node })))
    expect(again).toEqual(once)

    // A run that grew a node leaves what was drawn where it was.
    const grown = layOutGraph([...BUILD, nodeOf('gate-1', ['fixer-1'])])
    for (const node of BUILD) {
      expect(card(grown, node.id).x).toBe(card(once, node.id).x)
      expect(card(grown, node.id).y).toBe(card(once, node.id).y)
    }

    // A longer id widens every card, because no id is ever truncated; what
    // holds is the order, which is the record's and so the run's.
    const wider = layOutGraph([...BUILD, nodeOf('gate-alignment-1', ['fixer-1'])])
    const reading = (layout: ReturnType<typeof layOutGraph>): string[] =>
      [...layout.cards]
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((one) => one.id)
    expect(reading(wider).filter((id) => id !== 'gate-alignment-1')).toEqual(reading(once))
  })

  it('draws a corrupt record rather than hanging the window', () => {
    const layout = layOutGraph([
      nodeOf('a', ['b']),
      nodeOf('b', ['a']),
      nodeOf('c', ['c']),
      nodeOf('d', ['a', 'a'])
    ])

    expect(layout.cards.map((one) => one.id)).toEqual(['a', 'b', 'c', 'd'])
    // A node is never its own parent, whatever the record claims, and one
    // parent named twice is still one line.
    expect(layout.edges.some((edge) => edge.from === edge.to)).toBe(false)
    expect(layout.edges.filter((edge) => edge.to === 'd')).toHaveLength(1)
    expect(Number.isFinite(layout.width)).toBe(true)
    expect(Number.isFinite(layout.height)).toBe(true)
  })

  it('draws nothing at all for a record with no nodes', () => {
    const layout = layOutGraph([])
    expect(layout.cards).toEqual([])
    expect(layout.edges).toEqual([])
    expect(Number.isFinite(layout.width)).toBe(true)
  })
})

describe('what a card says', () => {
  it('gives the status as a word and a duration, never colour alone', () => {
    const done = cardFace(nodeOf('planner', [], { cost: 8.75, toolCalls: 61 }))
    expect(done.status).toBe('done · 12m')
    expect(done.tone).toBe('done')
    expect(done.facts).toBe('$8.75 · 61 tools')

    const running = cardFace(
      nodeOf('gate-alignment-1', [], {
        status: 'running',
        endedAt: undefined,
        startedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
        model: 'anthropic/claude-fable-5:high',
        contextPercent: 9,
        now: 'checking activeJump usages…'
      })
    )
    expect(running.status).toBe('running · 6m')
    expect(running.facts).toBe('fable-5:high · ctx 9%')
    expect(running.now).toBe('checking activeJump usages…')

    expect(cardFace(nodeOf('gate-verdict-1', [], { status: 'pending', startedAt: undefined })))
      .toMatchObject({ status: 'pending', tone: 'wait' })
    expect(cardFace(nodeOf('builder', [], { status: 'blocked' })).status).toBe('blocked · 12m')
  })

  it('puts a failure reason on the failed card, first line only', () => {
    const face = cardFace(
      nodeOf('perf-audit', [], {
        status: 'failed',
        error: 'the node stalled for 12m\nand said nothing further'
      })
    )
    expect(face.tone).toBe('bad')
    expect(face.error).toBe('the node stalled for 12m')
  })

  it('shows a verdict as text, tinted but never only tinted', () => {
    expect(cardFace(nodeOf('r', [], { verdict: { verdict: 'approved' } })).verdict).toEqual({
      text: 'approved',
      tone: 'ok'
    })
    expect(
      cardFace(nodeOf('r', [], { verdict: { verdict: 'changes-required' } })).verdict
    ).toEqual({ text: 'changes required', tone: 'warn' })
    expect(cardFace(nodeOf('r')).verdict).toBeUndefined()
  })
})

describe('the graph header count', () => {
  it('always counts the nodes and drops the segments that are zero', () => {
    expect(graphCount(BUILD)).toBe('6 nodes · 6 done')
    expect(
      graphCount([
        nodeOf('a'),
        nodeOf('b', ['a'], { status: 'running' }),
        nodeOf('c', ['a'], { status: 'failed' }),
        nodeOf('d', ['b'], { status: 'pending' })
      ])
    ).toBe('4 nodes · 1 done · 1 running · 1 failed')
    expect(graphCount([nodeOf('a', [], { status: 'pending' })])).toBe('1 node')
    expect(graphCount([])).toBe('0 nodes')
  })
})

describe('what an edge means', () => {
  const nodes = [
    nodeOf('planner'),
    nodeOf('builder', ['planner'], { status: 'running', endedAt: undefined }),
    nodeOf('review-1', ['builder'], { status: 'pending', startedAt: undefined }),
    nodeOf('fixer-1', ['builder'], { status: 'paused', endedAt: undefined })
  ]
  const layout = layOutGraph(nodes)
  const edge = (from: string, to: string) => {
    const found = layout.edges.find((one) => one.from === from && one.to === to)
    if (found === undefined) throw new Error(`no edge ${from}->${to}`)
    return found
  }

  it('reads walked, being walked, planned and selected, in that order of precedence', () => {
    expect(edgeState(edge('planner', 'builder'), nodes, undefined)).toBe('walking')
    expect(edgeState(edge('builder', 'review-1'), nodes, undefined)).toBe('planned')
    expect(edgeState(edge('builder', 'fixer-1'), nodes, undefined)).toBe('walking')

    // The shown node's own edges win over every other state, in and out.
    expect(edgeState(edge('planner', 'builder'), nodes, 'builder')).toBe('selected')
    expect(edgeState(edge('builder', 'review-1'), nodes, 'builder')).toBe('selected')
    // And nothing further out is lit: immediate edges only.
    expect(edgeState(edge('planner', 'builder'), nodes, 'review-1')).toBe('walking')
  })

  it('calls an edge walked once the node below it has settled', () => {
    const settled = nodes.map((node) =>
      node.id === 'builder' ? { ...node, status: 'complete' as const } : node
    )
    expect(edgeState(edge('planner', 'builder'), settled, undefined)).toBe('walked')
  })
})
