// @vitest-environment node
//
// What a loop is, read from ids alone. Nothing declares a loop, so this is the
// whole inference: a base name that recurs with rising round numbers, the
// rounds it opens, and which of the nodes between them belong to which round.
// A pure function of the record — its ids, the parents it can honor and when
// each node started — with no pane, no view and no status in it.
//
// The engine's own records are read here beside the hand-written ones, because
// the array order a workflow's `plan` leaves behind is not the order the run
// walked and the reading has to recover that first.
import { describe, expect, it } from 'vitest'
import type { RunNode } from '../../../shared/workflows/run'
import { baseName, readLoops, roundNumber, type LoopReading } from './loops'

function nodeOf(id: string, overrides: Partial<RunNode> = {}): RunNode {
  return {
    id,
    status: 'complete',
    parents: [],
    reads: [],
    artifacts: [],
    ...overrides
  }
}

/** A node that has run, with the parents the plan gave it and a start time. */
function ran(id: string, parents: string[], minute = 0): RunNode {
  const at = String(minute).padStart(2, '0')
  return nodeOf(id, {
    parents,
    startedAt: `2026-09-02T10:${at}:00.000Z`,
    endedAt: `2026-09-02T10:${at}:30.000Z`
  })
}

/** A node the plan forecast and the run has not reached: no start, no clock. */
function forecast(id: string, parents: string[]): RunNode {
  return nodeOf(id, { status: 'pending', parents })
}

/** The record's ids as a chain, each following the one before it. */
function chain(ids: readonly string[]): RunNode[] {
  return ids.map((id, at) => nodeOf(id, { parents: at === 0 ? [] : [ids[at - 1]] }))
}

/** What the reading says, in the record's own words: the loops and the spine. */
function shapeOf(
  nodes: readonly RunNode[]
): { readonly spine: string[]; readonly loops: string[][][] } {
  const held = readLoops(nodes)
  const loops: string[][][] = held.loops.map(() => [])
  const spine: string[] = []
  nodes.forEach((node, at) => {
    const spot = held.spots[at]
    if (spot.kind === 'spine') {
      spine.push(node.id)
      return
    }
    const rounds = loops[spot.loop]
    while (rounds.length <= spot.round) rounds.push([])
    rounds[spot.round][spot.index] = node.id
  })
  return { spine, loops }
}

/** The build run the intent brief is drawn from. */
const BUILD = [
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
  'gate-comments-1',
  'gate-verdict-1'
]

/** The merge gate looping once. */
const GATE = [
  'gate-alignment-1',
  'gate-comments-1',
  'gate-verdict-1',
  'gate-fixer-1',
  'gate-alignment-2',
  'gate-comments-2',
  'gate-verdict-2'
]

describe('what an id carries', () => {
  it('reads a round number off the digits after the last hyphen, and nothing else', () => {
    expect(roundNumber('review-2')).toBe(2)
    expect(roundNumber('gate-alignment-12')).toBe(12)
    expect(roundNumber('builder')).toBeUndefined()
    expect(roundNumber('analyst')).toBeUndefined()
    // A revision is the engine's replay of one node, not a round of a loop.
    expect(roundNumber('review-1·r1')).toBeUndefined()
  })

  it('calls what precedes the round number the base name, or else the whole id', () => {
    expect(baseName('review-2')).toBe('review')
    expect(baseName('gate-alignment-12')).toBe('gate-alignment')
    expect(baseName('builder')).toBe('builder')
    expect(baseName('review-1·r1')).toBe('review-1·r1')
  })
})

describe('the loops a record holds', () => {
  it('reads the build run the way the intent does, round by round', () => {
    const { spine, loops } = shapeOf(chain(BUILD))

    expect(loops).toEqual([
      [
        ['review-1', 'fixer-1'],
        ['review-2', 'check-fixer-1', 'fixer-2'],
        ['review-3']
      ]
    ])
    // check-fixer-1 sits in round 2 even though its base name appears once,
    // and the merge gate that follows starts the spine again.
    expect(spine).toEqual([
      'analyst',
      'architect',
      'builder',
      'gate-alignment-1',
      'gate-comments-1',
      'gate-verdict-1'
    ])
    expect(readLoops(chain(BUILD)).loops[0]).toEqual({
      leader: 'review',
      rounds: 3,
      depth: 3
    })
  })

  it('reads the merge gate loop, whose second round holds three nodes', () => {
    const { spine, loops } = shapeOf(chain(GATE))

    expect(loops).toEqual([
      [
        ['gate-alignment-1', 'gate-comments-1', 'gate-verdict-1', 'gate-fixer-1'],
        ['gate-alignment-2', 'gate-comments-2', 'gate-verdict-2']
      ]
    ])
    expect(spine).toEqual([])
    expect(readLoops(chain(GATE)).loops[0]).toMatchObject({ leader: 'gate-alignment', rounds: 2 })
  })

  it('leaves a base name with only one round number on the spine', () => {
    const { spine, loops } = shapeOf(chain(['planner', 'builder', 'review-1', 'fixer-1']))

    expect(loops).toEqual([])
    expect(spine).toEqual(['planner', 'builder', 'review-1', 'fixer-1'])
  })

  it('opens the loop at the first node whose base name recurs, and not before', () => {
    const held = readLoops(chain(['analyst', 'builder', 'review-1', 'review-2']))

    expect(held.spots[0]).toEqual({ kind: 'spine' })
    expect(held.spots[1]).toEqual({ kind: 'spine' })
    expect(held.spots[2]).toEqual({ kind: 'loop', loop: 0, round: 0, index: 0 })
    expect(held.spots[3]).toEqual({ kind: 'loop', loop: 0, round: 1, index: 0 })
  })

  it('admits a stranger mid-loop and refuses one in the last round', () => {
    // `audit` is nobody's round; mid-loop it joins the round in progress, and
    // in the last round the same name ends the loop instead.
    const { spine, loops } = shapeOf(
      chain(['review-1', 'audit', 'review-2', 'audit', 'review-3', 'audit', 'shipper'])
    )

    expect(loops).toEqual([
      [
        ['review-1', 'audit'],
        ['review-2', 'audit'],
        ['review-3', 'audit']
      ]
    ])
    // The third `audit` was admitted because the loop had already shown that
    // base name; `shipper` had not been seen, so it resumes the spine.
    expect(spine).toEqual(['shipper'])
  })

  it('holds more than one loop, each read on its own', () => {
    const { spine, loops } = shapeOf(chain([...BUILD, 'gate-fixer-1', 'gate-alignment-2']))

    expect(loops).toEqual([
      [
        ['review-1', 'fixer-1'],
        ['review-2', 'check-fixer-1', 'fixer-2'],
        ['review-3']
      ],
      [['gate-alignment-1', 'gate-comments-1', 'gate-verdict-1', 'gate-fixer-1'], ['gate-alignment-2']]
    ])
    expect(spine).toEqual(['analyst', 'architect', 'builder'])
  })

  it('reads nothing from a node’s status: a loop mid-flight reads like a finished one', () => {
    const finished = chain(GATE)
    const flying = finished.map((node, at) =>
      at < 4
        ? node
        : { ...node, status: at === 4 ? ('running' as const) : ('pending' as const) }
    )

    expect(readLoops(flying)).toEqual(readLoops(finished))
  })

  it('takes the record and nothing else, and says the same thing twice', () => {
    const nodes = chain(BUILD)
    const once = readLoops(nodes)

    expect(readLoops([...nodes])).toEqual(once)
    // A record the run already walked in array order reads the same with its
    // parents dropped: they only ever settle an order the array got wrong.
    expect(readLoops(nodes.map((node) => ({ ...node, parents: [] })))).toEqual(once)
  })

  it('reads a record the engine would never write without inventing a loop', () => {
    // A leading name whose later rounds never arrive is not a loop: the second
    // `review-1` opens nothing that closes, so its nodes stay on the spine.
    expect(shapeOf(chain(['review-1', 'review-2', 'ship', 'review-1', 'fixer-9']))).toEqual({
      spine: ['ship', 'review-1', 'fixer-9'],
      loops: [[['review-1'], ['review-2']]]
    })
    // A repeated round number, and round numbers with gaps: both draw, both
    // deterministically.
    expect(shapeOf(chain(['review-1', 'review-1', 'after']))).toEqual({
      spine: ['review-1', 'review-1', 'after'],
      loops: []
    })
    expect(shapeOf(chain(['review-1', 'review-3', 'after']))).toEqual({
      spine: ['after'],
      loops: [[['review-1'], ['review-3']]]
    })
  })

  it('gives every node exactly one spot, aligned with the record it read', () => {
    const nodes = chain([...BUILD, 'gate-fixer-1', 'gate-alignment-2'])
    const held = readLoops(nodes)

    expect(held.spots).toHaveLength(nodes.length)
    for (const spot of held.spots) {
      if (spot.kind === 'spine') continue
      expect(spot.loop).toBeGreaterThanOrEqual(0)
      expect(spot.loop).toBeLessThan(held.loops.length)
    }
    // Every loop is a real one, and its summary is a reading of its own spots.
    held.loops.forEach((loop, at) => {
      expect(loop.rounds).toBeGreaterThanOrEqual(2)
      expect(loop).toEqual({
        leader: loop.leader,
        rounds: distinctRounds(held, at),
        depth: deepestRound(held, at)
      })
    })
  })
})

describe('the order the run walked, which the record’s array is not', () => {
  // The build workflow's `plan` registers the merge gate's three nodes up
  // front, right behind `review-1`, and the engine writes a planned node back
  // into its own slot when it finally runs; the fixers and the later reviews
  // the plan never forecast are appended at the end. This is the intent's
  // 12-node run exactly as the engine wrote it (workflow-runs/d420/run.json),
  // and the reading it must give is the intent's: one review loop of three
  // rounds, the gate back on the spine after it.
  const ENGINE_BUILD: RunNode[] = [
    ran('analyst', []),
    ran('architect', ['analyst']),
    ran('builder', ['architect', 'analyst']),
    ran('review-1', ['builder', 'analyst', 'architect']),
    ran('gate-alignment-1', ['review-3', 'analyst', 'architect']),
    ran('gate-comments-1', ['gate-alignment-1']),
    ran('gate-verdict-1', ['gate-alignment-1', 'gate-comments-1', 'analyst']),
    ran('fixer-1', ['review-1', 'analyst', 'architect']),
    ran('review-2', ['fixer-1', 'analyst', 'architect', 'review-1']),
    ran('check-fixer-1', ['review-2', 'analyst', 'architect']),
    ran('fixer-2', ['check-fixer-1', 'analyst', 'architect', 'review-1', 'review-2']),
    ran('review-3', ['fixer-2', 'analyst', 'architect', 'review-1', 'review-2'])
  ]

  it('reads the gate after the loop it followed, not the slot the plan gave it', () => {
    const { spine, loops } = shapeOf(ENGINE_BUILD)

    expect(loops).toEqual([
      [
        ['review-1', 'fixer-1'],
        ['review-2', 'check-fixer-1', 'fixer-2'],
        ['review-3']
      ]
    ])
    expect(spine).toEqual([
      'analyst',
      'architect',
      'builder',
      'gate-alignment-1',
      'gate-comments-1',
      'gate-verdict-1'
    ])
    // Spots stay aligned with the array they were given, whatever order they
    // were read in: the gate's slot is the fifth, and it is a spine spot.
    expect(readLoops(ENGINE_BUILD).spots[4]).toEqual({ kind: 'spine' })
  })

  it('leaves the plan’s forecasts out of the loop they were forecast into', () => {
    // The same run in flight, on its second review round. The gate's nodes are
    // still ghosts the plan hung under `review-1`; nothing has run them, so
    // they read after everything that has run, on the spine.
    const { spine, loops } = shapeOf([
      ran('analyst', [], 1),
      ran('architect', ['analyst'], 2),
      ran('builder', ['architect', 'analyst'], 3),
      ran('review-1', ['builder', 'analyst', 'architect'], 4),
      forecast('gate-alignment-1', ['review-1']),
      forecast('gate-comments-1', ['gate-alignment-1']),
      forecast('gate-verdict-1', ['gate-alignment-1', 'gate-comments-1']),
      ran('check-fixer-1', ['review-1', 'analyst', 'architect'], 5),
      ran('fixer-1', ['check-fixer-1', 'analyst', 'architect', 'review-1'], 6),
      nodeOf('review-2', {
        status: 'running',
        parents: ['fixer-1', 'analyst', 'architect', 'review-1'],
        startedAt: '2026-09-02T10:07:00.000Z'
      })
    ])

    expect(loops).toEqual([[['review-1', 'check-fixer-1', 'fixer-1'], ['review-2']]])
    expect(spine).toEqual([
      'analyst',
      'architect',
      'builder',
      'gate-alignment-1',
      'gate-comments-1',
      'gate-verdict-1'
    ])
  })

  it('lets the clock settle two nodes the parents leave level', () => {
    // `audit` and the reviews all hang off `builder`, so nothing about the
    // parents says which ran when. The record's own start times do: `audit`
    // ran after the last review opened, so it is the run moving on and not a
    // stranger caught in the first round, which is where the array's order
    // would have put it.
    const { spine, loops } = shapeOf([
      ran('builder', [], 1),
      ran('review-1', ['builder'], 2),
      ran('audit', ['builder'], 4),
      ran('review-2', ['builder'], 3)
    ])

    expect(loops).toEqual([[['review-1'], ['review-2']]])
    expect(spine).toEqual(['builder', 'audit'])
  })

  it('reads a record that walks into itself, in the order the array holds it', () => {
    // Nothing is ever ready in a cycle. The reading falls back to the array,
    // one node at a time, rather than hanging the window (R64).
    const nodes = [
      nodeOf('review-1', { parents: ['review-2'] }),
      nodeOf('fixer-1', { parents: ['review-1'] }),
      nodeOf('review-2', { parents: ['fixer-1'] })
    ]

    expect(shapeOf(nodes)).toEqual({
      spine: [],
      loops: [[['review-1', 'fixer-1'], ['review-2']]]
    })
  })
})

function distinctRounds(held: LoopReading, loop: number): number {
  return new Set(
    held.spots.filter((spot) => spot.kind === 'loop' && spot.loop === loop).map((spot) =>
      spot.kind === 'loop' ? spot.round : -1
    )
  ).size
}

function deepestRound(held: LoopReading, loop: number): number {
  const counted = new Map<number, number>()
  for (const spot of held.spots) {
    if (spot.kind !== 'loop' || spot.loop !== loop) continue
    counted.set(spot.round, (counted.get(spot.round) ?? 0) + 1)
  }
  return Math.max(...counted.values())
}
