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

/** A record as a chain: every node follows the one the record names before it. */
function chain(ids: readonly string[]): RunNode[] {
  return ids.map((id, at) => nodeOf(id, at === 0 ? [] : [ids[at - 1]]))
}

interface Point {
  readonly x: number
  readonly y: number
}

/** Every point a path visits, its curves flattened, control points dropped. */
function along(d: string): Point[] {
  const walked: Point[] = []
  let at: Point = { x: 0, y: 0 }
  for (const command of d.match(/[MLCQ][^MLCQ]*/g) ?? []) {
    const numbers = (command.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    const points: Point[] = []
    for (let read = 0; read + 1 < numbers.length; read += 2) {
      points.push({ x: numbers[read], y: numbers[read + 1] })
    }
    if (command[0] === 'M' || command[0] === 'L') walked.push(...points)
    else for (let step = 0; step <= 24; step++) walked.push(bezier([at, ...points], step / 24))
    at = points[points.length - 1]
  }
  return walked
}

/** de Casteljau, which is all a curve is: corners cut until a point is left. */
function bezier(points: readonly Point[], t: number): Point {
  let held = points
  while (held.length > 1) {
    const from = held
    held = from.slice(1).map((point, at) => ({
      x: from[at].x + (point.x - from[at].x) * t,
      y: from[at].y + (point.y - from[at].y) * t
    }))
  }
  return held[0]
}

type Layout = ReturnType<typeof layOutGraph>

function expectNothingOverlaps(layout: Layout): void {
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
}

/** No edge passes through a card: touching an edge of one is what a line does. */
function expectNoEdgeCrossesACard(layout: Layout): void {
  for (const edge of layout.edges) {
    for (const point of along(edge.d)) {
      for (const one of layout.cards) {
        const inside =
          point.x > one.x + 0.5 &&
          point.x < one.x + layout.cardWidth - 0.5 &&
          point.y > one.y + 0.5 &&
          point.y < one.y + layout.cardHeight - 0.5
        expect(inside, `${edge.from}→${edge.to} crosses ${one.id}`).toBe(false)
      }
    }
  }
}

/** The reported extent holds every card and every point of every path. */
function expectExtentHoldsEverything(layout: Layout): void {
  for (const one of layout.cards) {
    expect(one.x).toBeGreaterThanOrEqual(0)
    expect(one.y).toBeGreaterThanOrEqual(0)
    expect(one.x + layout.cardWidth).toBeLessThanOrEqual(layout.width)
    expect(one.y + layout.cardHeight).toBeLessThanOrEqual(layout.height)
  }
  for (const edge of layout.edges) {
    for (const point of along(edge.d)) {
      expect(point.x, `${edge.from}→${edge.to} left of the drawing`).toBeGreaterThanOrEqual(0)
      expect(point.y, `${edge.from}→${edge.to} above the drawing`).toBeGreaterThanOrEqual(0)
      expect(point.x, `${edge.from}→${edge.to} past the drawing`).toBeLessThanOrEqual(layout.width)
      expect(point.y, `${edge.from}→${edge.to} under the drawing`).toBeLessThanOrEqual(
        layout.height
      )
    }
  }
}

/** The build run of the intent brief: one loop of three rounds, then the gate. */
const LOOPED: RunNode[] = [
  ...chain([
    'analyst',
    'architect',
    'builder',
    'review-1',
    'fixer-1',
    'review-2',
    'check-fixer-1',
    'fixer-2',
    'review-3',
    'gate-alignment-1',
    'gate-comments-1'
  ]),
  nodeOf('gate-verdict-1', ['gate-alignment-1', 'gate-comments-1'])
]

/** The merge gate looping once: a loop whose first round is four deep. */
const GATE: RunNode[] = chain([
  'gate-alignment-1',
  'gate-comments-1',
  'gate-verdict-1',
  'gate-fixer-1',
  'gate-alignment-2',
  'gate-comments-2',
  'gate-verdict-2'
])

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

  it('bows a revision’s edge to its base around the round between, so a send-back reaches back up the page', () => {
    const layout = layOutGraph([
      nodeOf('planner'),
      nodeOf('builder', ['planner']),
      nodeOf('review-1', ['builder']),
      nodeOf('fixer-1', ['review-1']),
      // Parents as revise() writes them: the base, then the fixer that
      // answered the round it was sent back over.
      nodeOf('review-1·r1', ['review-1', 'fixer-1'])
    ])
    const bowed = layout.edges.find((edge) => edge.from === 'review-1' && edge.to === 'review-1·r1')

    expect(bowed).toBeDefined()
    // A whole round stands between the two ends, which is what makes this
    // line the one that travels back up the page rather than one step down.
    expect(card(layout, 'review-1·r1').layer - card(layout, 'review-1').layer).toBe(2)
    expect(card(layout, 'review-1').y).toBeLessThan(card(layout, 'fixer-1').y)

    // The long run of the line is a straight vertical segment, and it is
    // clear of every card it passes.
    const lane = Number(/L([-\d.]+),/.exec(bowed?.d ?? '')?.[1])
    expect(Number.isNaN(lane)).toBe(false)
    const passed = layout.cards.filter((one) => one.layer === card(layout, 'fixer-1').layer)
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

describe('a loop, laid out left to right', () => {
  const layout = layOutGraph(LOOPED)
  const route = (from: string, to: string) => {
    const found = layout.edges.find((edge) => edge.from === from && edge.to === to)
    if (found === undefined) throw new Error(`no edge ${from}->${to}`)
    return found
  }

  it('gives each round a column, left to right, and stacks the round down it', () => {
    // Three rounds, three columns, evenly apart and never overlapping.
    const columns = ['review-1', 'review-2', 'review-3'].map((id) => card(layout, id).x)
    expect(columns[0]).toBeLessThan(columns[1])
    expect(columns[1]).toBeLessThan(columns[2])
    expect(columns[1] - columns[0]).toBe(columns[2] - columns[1])
    expect(columns[1] - columns[0]).toBeGreaterThan(layout.cardWidth)

    // Every round starts on the loop's top row, and its nodes stack one row
    // apart in record order: review-2, check-fixer-1, fixer-2 down one column.
    expect(card(layout, 'review-2').layer).toBe(card(layout, 'review-1').layer)
    expect(card(layout, 'review-3').layer).toBe(card(layout, 'review-1').layer)
    expect(card(layout, 'fixer-1').layer).toBe(card(layout, 'review-1').layer + 1)
    expect(card(layout, 'check-fixer-1').layer).toBe(card(layout, 'review-2').layer + 1)
    expect(card(layout, 'fixer-2').layer).toBe(card(layout, 'review-2').layer + 2)
    for (const id of ['check-fixer-1', 'fixer-2']) {
      expect(card(layout, id).x).toBe(card(layout, 'review-2').x)
    }
    expect(card(layout, 'fixer-1').x).toBe(card(layout, 'review-1').x)
  })

  it('stands the loop on the spine and brings the run back under its first column', () => {
    // Where the leading node would have gone anyway: under its parent.
    expect(centre(layout, 'review-1')).toBeCloseTo(centre(layout, 'builder'), 5)
    // And the spine leaves the loop where it entered it, three rows down —
    // the loop's deepest round — however wide the loop got.
    expect(centre(layout, 'gate-alignment-1')).toBeCloseTo(centre(layout, 'review-1'), 5)
    expect(card(layout, 'gate-alignment-1').layer).toBe(card(layout, 'review-1').layer + 3)
    const spine = ['analyst', 'architect', 'builder', 'review-1', 'gate-alignment-1']
    expect(new Set(spine.map((id) => card(layout, id).x)).size).toBe(1)
  })

  it('widens with rounds and deepens with its tallest round, never the other way', () => {
    const columnsOf = (held: Layout): number => new Set(held.cards.map((one) => one.x)).size
    const rowsOf = (held: Layout): number => new Set(held.cards.map((one) => one.y)).size
    const two = layOutGraph(chain(['a-1', 'p-1', 'a-2', 'p-2']))
    const deeper = layOutGraph(chain(['a-1', 'p-1', 'q-1', 'a-2', 'p-2']))
    const wider = layOutGraph(chain(['a-1', 'p-1', 'a-2', 'p-2', 'a-3']))

    expect([columnsOf(two), rowsOf(two)]).toEqual([2, 2])
    // A node added to a round deepens the loop and never widens it.
    expect([columnsOf(deeper), rowsOf(deeper)]).toEqual([2, 3])
    // A round added widens it and never deepens it.
    expect([columnsOf(wider), rowsOf(wider)]).toEqual([3, 2])
  })

  it('overlaps no two cards and keeps the gaps even, loop columns included', () => {
    expectNothingOverlaps(layout)
    expectNothingOverlaps(layOutGraph(GATE))

    const rows = [...new Set(layout.cards.map((one) => one.y))].sort((a, b) => a - b)
    const steps = rows.slice(1).map((y, at) => y - rows[at])
    expect(new Set(steps).size).toBe(1)
  })

  it('lets a fan-out stand beside a loop rather than inside it', () => {
    const beside = layOutGraph([
      nodeOf('planner'),
      nodeOf('builder', ['planner']),
      // Before the loop opens, so it is a sibling of the leading node rather
      // than a member of its first round.
      nodeOf('audit', ['builder']),
      nodeOf('review-1', ['builder']),
      nodeOf('fixer-1', ['review-1']),
      nodeOf('review-2', ['fixer-1']),
      nodeOf('shipper', ['review-2', 'audit'])
    ])

    expectNothingOverlaps(beside)
    // The sibling keeps the row it always had, and stands clear of the room
    // the loop takes rather than in the middle of it.
    expect(card(beside, 'audit').layer).toBe(card(beside, 'review-1').layer)
    expect(card(beside, 'audit').x).toBeGreaterThanOrEqual(
      card(beside, 'review-2').x + beside.cardWidth
    )
    expectNoEdgeCrossesACard(beside)
  })

  it('routes round to round sideways, down a column straight, and out along the band', () => {
    expect(route('fixer-1', 'review-2').route).toEqual({ kind: 'across' })
    expect(route('fixer-2', 'review-3').route).toEqual({ kind: 'across' })
    expect(route('review-2', 'check-fixer-1').route).toEqual({ kind: 'direct' })

    // Out of the parent's right side and into the child's left, even though
    // the child sits higher on the page.
    const across = along(route('fixer-1', 'review-2').d)
    expect(across[0].x).toBe(card(layout, 'fixer-1').x + layout.cardWidth)
    expect(across[across.length - 1].x).toBe(card(layout, 'review-2').x)
    expect(card(layout, 'review-2').y).toBeLessThan(card(layout, 'fixer-1').y)

    // Leaving the loop: down, back along the empty band beneath the loop, and
    // into the top of the node the run moved on to.
    const out = route('review-3', 'gate-alignment-1')
    expect(out.route.kind).toBe('return')
    const band = out.route.kind === 'return' ? out.route.band : 0
    const deepest = Math.max(
      ...['fixer-1', 'fixer-2', 'review-3'].map((id) => card(layout, id).y + layout.cardHeight)
    )
    expect(band).toBeGreaterThan(deepest)
    expect(band).toBeLessThan(card(layout, 'gate-alignment-1').y)
    const walked = along(out.d)
    expect(walked[walked.length - 1]).toEqual({
      x: centre(layout, 'gate-alignment-1'),
      y: card(layout, 'gate-alignment-1').y
    })
  })

  it('passes no edge through a card, and holds every path inside the drawing', () => {
    for (const held of [layout, layOutGraph(GATE), layOutGraph(BUILD)]) {
      expectNoEdgeCrossesACard(held)
      expectExtentHoldsEverything(held)
    }
  })

  it('draws the same loop twice, whatever the nodes are doing', () => {
    expect(layOutGraph(LOOPED.map((node) => ({ ...node })))).toEqual(layout)
    // Status plays no part in the geometry: a loop mid-flight draws its
    // rounds where a finished one draws them.
    const flying = layOutGraph(
      LOOPED.map((node) =>
        node.id === 'review-3' ? { ...node, status: 'running' as const, endedAt: undefined } : node
      )
    )
    for (const node of LOOPED) {
      expect(card(flying, node.id).x).toBe(card(layout, node.id).x)
      expect(card(flying, node.id).y).toBe(card(layout, node.id).y)
    }
  })

  it('draws round numbers that gap, that fall and that never arrive', () => {
    const gapped = chain(['review-1', 'fixer-1', 'review-4', 'ship-1'])
    const falling = chain(['review-2', 'fixer-1', 'review-1', 'fixer-2'])
    // A leading name that opens on its own last round, so the rounds it would
    // have led never arrive.
    const abandoned = chain(['review-3', 'ship', 'review-1', 'review-2'])

    for (const record of [gapped, falling, abandoned]) {
      const held = layOutGraph(record)
      expect(held.cards.map((one) => one.id)).toEqual(record.map((node) => node.id))
      expect(Number.isFinite(held.width)).toBe(true)
      expect(Number.isFinite(held.height)).toBe(true)
      expectNothingOverlaps(held)
      expectExtentHoldsEverything(held)
      expectNoEdgeCrossesACard(held)
      expect(layOutGraph(record.map((node) => ({ ...node })))).toEqual(held)
    }
  })

  it('draws a cycle, a self-parent and a record that names two nodes the same', () => {
    const cyclic = [
      nodeOf('review-1', ['review-2']),
      nodeOf('review-2', ['review-1']),
      nodeOf('review-3', ['review-3']),
      nodeOf('fixer-1', ['review-1', 'review-1']),
      nodeOf('after', ['ghost-that-was-pruned'])
    ]
    const held = layOutGraph(cyclic)

    expect(held.cards.map((one) => one.id)).toEqual(cyclic.map((node) => node.id))
    expect(held.edges.some((edge) => edge.from === edge.to)).toBe(false)
    expect(held.edges.filter((edge) => edge.to === 'fixer-1')).toHaveLength(1)
    expectNothingOverlaps(held)
    expectExtentHoldsEverything(held)
    // A cycle's back edge is drawn level with the card it came from, which is
    // the one shape no route can keep clear; such a record asks only to be
    // drawn at all.

    // Two nodes under one id are one place in a picture that names places by
    // id: they still get a card each, and the drawing still ends.
    const twinned = layOutGraph([
      nodeOf('review-1'),
      nodeOf('fixer-1', ['review-1']),
      nodeOf('review-1', ['fixer-1'])
    ])
    expect(twinned.cards).toHaveLength(3)
    expect(Number.isFinite(twinned.width)).toBe(true)
    expect(Number.isFinite(twinned.height)).toBe(true)
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
