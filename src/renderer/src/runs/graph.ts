import type { RunNode } from '../../../shared/workflows/run'
import { money, nodeDuration, shortModel } from './format'
import { readLoops, type Loop, type LoopReading, type NodeSpot } from './loops'

// The run graph's geometry: a pure function from a run record's nodes to
// positioned cards and routed edges. Layered top-down, longest-path depth, one
// column per root, independent subtrees side by side — and a loop read out of
// the ids laid sideways, one column per round, with the spine resuming under
// the loop's first column. The same record always yields the identical
// picture — that determinism is what lets the graph be read at a glance and
// what these numbers are tested on.

/** Below this a card stops being readable, whatever its ids are. */
const MIN_CARD_WIDTH = 168

/** Card padding, and the room the status word keeps at the end of the title row. */
const CARD_PAD_X = 11
const STATUS_ROOM = 78

/** Rough advance of the card title's face, which is what sizes a card. */
const ID_CHAR_WIDTH = 7.2

// What one card measures, mirroring what runs.css draws: the title row, each
// meta line under it with its own margin, the padding and the border.
const TITLE_LINE = 18
const META_LINE = 17
const CARD_PAD_Y = 8
const CARD_BORDER = 1

const COLUMN_GAP = 28
const LAYER_GAP = 36
/** What separates two independent subtrees, wider than two siblings. */
const COMPONENT_GAP = 56

/** How far a bowing edge stays clear of the cards it goes around. */
const CHANNEL_CLEARANCE = 10

/** Room around the drawing, so a card's outline is not clipped by the pane. */
const CANVAS_MARGIN = 4

/** How far a return edge rounds the two corners of its band. */
const CORNER = 12

export type CardTone = 'done' | 'live' | 'bad' | 'wait' | 'parked'

/** What one card says, top to bottom. Absent parts are not drawn. */
export interface CardFace {
  readonly id: string
  /** `done · 12m`, `running · 6m`, bare `pending`. Never colour alone. */
  readonly status: string
  /** model · cost · tools, plus `ctx N%` while running. */
  readonly facts?: string
  readonly verdict?: { readonly text: string; readonly tone: 'ok' | 'warn' }
  /** What the node's agent is doing right now. */
  readonly now?: string
  /** The first line of a failed node's error. */
  readonly error?: string
  readonly tone: CardTone
}

export interface GraphCard {
  readonly node: RunNode
  readonly id: string
  /**
   * The row the card sits on, counting from the top. Outside a loop this is
   * still longest-path depth from the roots; inside one it is the loop's top
   * row plus the node's index in its round, so a later round can sit level
   * with the first.
   */
  readonly layer: number
  readonly x: number
  readonly y: number
}

/** How one edge travels, decided before any path is written. */
export type EdgeRoute =
  /** Adjacent rows with nothing in the way: straight, or gently curved. */
  | { readonly kind: 'direct' }
  /** Down a free vertical lane at this x, clear of every card it passes. */
  | { readonly kind: 'lane'; readonly lane: number }
  /** Round to round: out of the parent's right side, into the child's left. */
  | { readonly kind: 'across' }
  /** Out of a loop: down the lane, back along the band at `band`, into the child's top. */
  | { readonly kind: 'return'; readonly lane: number; readonly band: number }

export interface GraphEdge {
  readonly from: string
  readonly to: string
  readonly route: EdgeRoute
  /** SVG path data, derived here from `route` and the two cards. */
  readonly d: string
}

export interface GraphLayout {
  readonly cards: readonly GraphCard[]
  readonly edges: readonly GraphEdge[]
  readonly cardWidth: number
  readonly cardHeight: number
  /**
   * The drawing's extent: every card and every point of every path lies
   * inside (0,0)–(width,height).
   */
  readonly width: number
  readonly height: number
}

/** A stretch of a row that is already taken, in layout units. */
interface Span {
  readonly from: number
  readonly to: number
}

/**
 * The graph of one run record: every node once, every edge its `parents` name
 * that the record can honor. A parent id naming no node is skipped rather
 * than drawn to nothing.
 */
export function layOutGraph(nodes: readonly RunNode[]): GraphLayout {
  const index = new Map(nodes.map((node, at) => [node.id, at]))
  const cardWidth = widthFor(nodes)
  const cardHeight = heightFor(nodes)

  // One edge per parent, whatever the record repeats, and never one to a node
  // the record no longer holds or to the node itself.
  const parentsOf = (node: RunNode): readonly string[] => [
    ...new Set(node.parents.filter((parent) => parent !== node.id && index.has(parent)))
  ]

  const reading = readLoops(nodes)
  const rows = rowsOf(nodes, parentsOf, reading)
  const columns = columnsOf(nodes, parentsOf, reading, rows, cardWidth)

  // Cards stay positionally aligned with the record: `raw[at]` draws
  // `nodes[at]`, which is what `reading.spots[at]` describes.
  const raw: GraphCard[] = nodes.map((node) => {
    const layer = rows.get(node.id) ?? 0
    return {
      node,
      id: node.id,
      layer,
      x: columns.get(node.id) ?? 0,
      y: layer * (cardHeight + LAYER_GAP)
    }
  })

  // Routes first, positions after: a bow to the left of the leftmost card or a
  // band above the topmost one moves the whole drawing, and a path string
  // cannot be re-read.
  const routes = nodes.flatMap((node, at) =>
    parentsOf(node).map((parent) => {
      const from = raw[index.get(parent) as number]
      return {
        from: index.get(parent) as number,
        to: at,
        route: routeFor(from, raw[at], reading, raw, cardWidth)
      }
    })
  )

  const drafts = routes.map((route) =>
    pathFor(route.route, raw[route.from], raw[route.to], cardWidth, cardHeight)
  )
  const offset = {
    x: CANVAS_MARGIN - Math.min(0, ...drafts.flatMap((d) => coordsOf(d, 0))),
    y: CANVAS_MARGIN - Math.min(0, ...drafts.flatMap((d) => coordsOf(d, 1)))
  }
  const cards = raw.map((card) => ({ ...card, x: card.x + offset.x, y: card.y + offset.y }))

  const edges: GraphEdge[] = routes.map((held) => {
    const route = moved(held.route, offset)
    const from = cards[held.from]
    const to = cards[held.to]
    return { from: from.id, to: to.id, route, d: pathFor(route, from, to, cardWidth, cardHeight) }
  })

  return {
    cards,
    edges,
    cardWidth,
    cardHeight,
    width:
      Math.max(
        0,
        ...cards.map((card) => card.x + cardWidth),
        ...edges.flatMap((edge) => coordsOf(edge.d, 0))
      ) + CANVAS_MARGIN,
    height:
      Math.max(
        0,
        ...cards.map((card) => card.y + cardHeight),
        ...edges.flatMap((edge) => coordsOf(edge.d, 1))
      ) + CANVAS_MARGIN
  }
}

/**
 * A node's card face. `now` is only read for the elapsed time of a node still
 * working, so two calls a minute apart differ in nothing but that.
 */
export function cardFace(node: RunNode, now = Date.now()): CardFace {
  const duration = nodeDuration(node, now)
  const word = statusWord(node)
  const facts = [
    shortModel(node.model),
    money(node.cost),
    node.toolCalls === undefined || node.toolCalls === 0 ? '' : `${node.toolCalls} tools`,
    node.status === 'running' && node.contextPercent !== undefined
      ? `ctx ${node.contextPercent}%`
      : ''
  ]
    .filter((part) => part !== '')
    .join(' · ')
  const verdict = verdictOf(node)
  return {
    id: node.id,
    status: node.status === 'pending' || duration === '' ? word : `${word} · ${duration}`,
    ...(facts === '' ? {} : { facts }),
    ...(verdict === undefined ? {} : { verdict }),
    ...(node.status === 'running' && node.now !== undefined ? { now: node.now } : {}),
    ...(node.status === 'failed' && node.error !== undefined
      ? { error: firstLine(node.error) }
      : {}),
    tone: toneOf(node)
  }
}

/** The header's live count: `9 nodes · 6 done · 1 running`, zeroes omitted. */
export function graphCount(nodes: readonly RunNode[]): string {
  const of = (status: RunNode['status']): number =>
    nodes.filter((node) => node.status === status).length
  return [
    `${nodes.length} ${nodes.length === 1 ? 'node' : 'nodes'}`,
    of('complete') === 0 ? '' : `${of('complete')} done`,
    of('running') === 0 ? '' : `${of('running')} running`,
    of('failed') === 0 ? '' : `${of('failed')} failed`,
    of('interrupted') === 0 ? '' : `${of('interrupted')} interrupted`
  ]
    .filter((part) => part !== '')
    .join(' · ')
}

export type EdgeState = 'selected' | 'planned' | 'walking' | 'walked'

/**
 * What an edge means right now, first match winning: an edge of the shown
 * node, a path not yet walked, work in flight, or work that has passed.
 */
export function edgeState(
  edge: Pick<GraphEdge, 'from' | 'to'>,
  nodes: readonly RunNode[],
  shownId: string | undefined
): EdgeState {
  if (edge.from === shownId || edge.to === shownId) return 'selected'
  const from = nodes.find((node) => node.id === edge.from)
  const to = nodes.find((node) => node.id === edge.to)
  if (from?.status === 'pending' || to?.status === 'pending') return 'planned'
  if (to?.status !== 'complete' && to?.status !== 'failed') return 'walking'
  return 'walked'
}

/** Ids are never truncated, so the longest one is what sizes every card. */
function widthFor(nodes: readonly RunNode[]): number {
  const longest = Math.max(0, ...nodes.map((node) => node.id.length))
  return Math.max(MIN_CARD_WIDTH, Math.ceil(2 * CARD_PAD_X + longest * ID_CHAR_WIDTH + STATUS_ROOM))
}

/** One height for the whole graph: the fullest card decides, so gaps stay even. */
function heightFor(nodes: readonly RunNode[]): number {
  const lines = Math.max(1, ...nodes.map((node) => metaLines(node)))
  return 2 * (CARD_PAD_Y + CARD_BORDER) + TITLE_LINE + lines * META_LINE
}

/** How many lines under the title a node's card draws. */
function metaLines(node: RunNode): number {
  const face = cardFace(node)
  return [face.facts, face.verdict, face.now, face.error].filter((part) => part !== undefined)
    .length
}

/**
 * Every node's row. A loop member's row is its loop's top row plus its index
 * in its round, so every round starts level with the first. Any other node
 * sits one below the lowest row its parents release — and a parent inside a
 * loop releases the row under the loop's deepest one, which is what puts the
 * node after a loop below the whole excursion. For a record with no loop this
 * is longest-path depth, exactly as it has always been.
 */
function rowsOf(
  nodes: readonly RunNode[],
  parentsOf: (node: RunNode) => readonly string[],
  reading: LoopReading
): Map<string, number> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const spots = spotsById(nodes, reading)
  const leads = leadingNodes(nodes, reading)
  const rows = new Map<string, number>()
  const tops = new Map<number, number>()

  // The row a parent releases to its children: the one under itself, or the
  // one under the whole loop it stands in.
  function releaseOf(id: string, walking: Set<string>): number {
    const spot = spots.get(id)
    if (spot !== undefined && spot.kind === 'loop') {
      return topOf(spot.loop, walking) + (reading.loops[spot.loop]?.depth ?? 1)
    }
    return rowOf(id, walking) + 1
  }

  function topOf(loop: number, walking: Set<string>): number {
    const held = tops.get(loop)
    if (held !== undefined) return held
    const lead = leads.get(loop)
    // A cycle cannot happen in a real run record; the guard keeps a corrupt
    // one from hanging the window.
    if (lead === undefined || walking.has(lead.id)) return 0
    walking.add(lead.id)
    const parents = parentsOf(lead)
    const top =
      parents.length === 0 ? 0 : Math.max(...parents.map((id) => releaseOf(id, walking)))
    walking.delete(lead.id)
    tops.set(loop, top)
    return top
  }

  function rowOf(id: string, walking: Set<string>): number {
    const held = rows.get(id)
    if (held !== undefined) return held
    const spot = spots.get(id)
    if (spot !== undefined && spot.kind === 'loop') {
      const row = topOf(spot.loop, walking) + spot.index
      rows.set(id, row)
      return row
    }
    const node = byId.get(id)
    if (node === undefined || walking.has(id)) return 0
    walking.add(id)
    const parents = parentsOf(node)
    const row =
      parents.length === 0 ? 0 : Math.max(...parents.map((parent) => releaseOf(parent, walking)))
    walking.delete(id)
    rows.set(id, row)
    return row
  }

  for (const node of nodes) rowOf(node.id, new Set())
  return rows
}

/**
 * Every card's left edge. Rows are placed top down, one weakly connected
 * component at a time, by the rules the graph has always had: siblings
 * adjacent and centred under their parent, a fan-in under the spread of its
 * parents, record order settling ties, and a block that wants taken room
 * starting where the last one ended. Loops enter in two places — a loop's
 * leading node reserves its whole rectangle from its own column rightward, and
 * a parent inside a loop anchors its children at that lead column, so the
 * spine leaves the loop straight under where it entered.
 */
function columnsOf(
  nodes: readonly RunNode[],
  parentsOf: (node: RunNode) => readonly string[],
  reading: LoopReading,
  rows: Map<string, number>,
  cardWidth: number
): Map<string, number> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const index = new Map(nodes.map((node, at) => [node.id, at]))
  const spots = spotsById(nodes, reading)
  const leads = leadingNodes(nodes, reading)
  const left = new Map<string, number>()
  const leadX = new Map<number, number>()

  const loopOf = (node: RunNode): Extract<NodeSpot, { kind: 'loop' }> | undefined => {
    const spot = spots.get(node.id)
    return spot !== undefined && spot.kind === 'loop' ? spot : undefined
  }

  // Where a child of this node wants to stand: under the node, or under the
  // first column of the loop it sits in.
  const anchorOf = (id: string): number | undefined => {
    const spot = spots.get(id)
    if (spot !== undefined && spot.kind === 'loop') return leadX.get(spot.loop)
    return left.get(id)
  }

  const wantedFor = (node: RunNode): number => {
    const anchors = parentsOf(node)
      .map(anchorOf)
      .filter((x): x is number => x !== undefined)
    // A root wants nothing in particular, so it packs to the left in record
    // order and starts its own column.
    return anchors.length === 0
      ? Number.NEGATIVE_INFINITY
      : anchors.reduce((sum, x) => sum + x + cardWidth / 2, 0) / anchors.length
  }

  const placeRow = (row: readonly RunNode[], at: number, reserved: Map<number, Span[]>): void => {
    const blocked = reserved.get(at) ?? []
    reserved.set(at, blocked)

    // The loop's leading node first: its column is where the whole loop
    // stands, and everything placed after it keeps clear of the room it takes.
    for (const node of row) {
      const spot = loopOf(node)
      if (spot === undefined || leads.get(spot.loop) !== node) continue
      const x = placeBlock(1, wantedFor(node), Number.NEGATIVE_INFINITY, blocked, cardWidth)
      left.set(node.id, x)
      leadX.set(spot.loop, x)
      reserve(reading.loops[spot.loop], x, at, reserved, cardWidth)
    }

    // The loop's other nodes stand in their round's column, not under their
    // own parents: that is what makes the rounds read left to right.
    const free: RunNode[] = []
    for (const node of row) {
      if (left.has(node.id)) continue
      const spot = loopOf(node)
      const lead = spot === undefined ? undefined : leadX.get(spot.loop)
      if (spot === undefined || lead === undefined) {
        free.push(node)
        continue
      }
      const x = lead + spot.round * (cardWidth + COLUMN_GAP)
      left.set(node.id, x)
      blocked.push({ from: x, to: x + cardWidth })
    }

    const wanted = new Map(free.map((node) => [node.id, wantedFor(node)]))
    // Stable, so record order — which is execution order — settles every tie
    // and the picture holds still as the run grows.
    const ordered = [...free].sort((a, b) => {
      const wantsA = wanted.get(a.id) as number
      const wantsB = wanted.get(b.id) as number
      if (wantsA === wantsB) return 0
      return wantsA < wantsB ? -1 : 1
    })

    let cursor = Number.NEGATIVE_INFINITY
    for (let held = 0; held < ordered.length; ) {
      // Cards wanting the same spot are one parent's siblings; they sit
      // adjacent, and the block as a whole is centred where they wanted to be.
      const centre = wanted.get(ordered[held].id) as number
      let end = held
      while (end < ordered.length && wanted.get(ordered[end].id) === centre) end += 1
      const block = ordered.slice(held, end)
      let x = placeBlock(block.length, centre, cursor, blocked, cardWidth)
      for (const node of block) {
        left.set(node.id, x)
        x += cardWidth + COLUMN_GAP
      }
      cursor = x
      held = end
    }
  }

  let componentStart = 0
  for (const component of componentOrder(nodes, parentsOf, index)) {
    const members = component.map((id) => byId.get(id) as RunNode)
    const deepest = Math.max(...members.map((node) => rows.get(node.id) ?? 0))
    // Room a loop has reserved, by row. Held per component, because
    // components already stand in bands of their own.
    const reserved = new Map<number, Span[]>()
    for (let row = 0; row <= deepest; row++) {
      placeRow(
        members.filter((node) => (rows.get(node.id) ?? 0) === row),
        row,
        reserved
      )
    }
    const xs = members.map((node) => left.get(node.id) ?? 0)
    const shift = componentStart - Math.min(...xs)
    for (const node of members) left.set(node.id, (left.get(node.id) ?? 0) + shift)
    // The loops of this component move with it, so a child placed later still
    // lands under the loop's first column.
    for (const [loop, lead] of leads) {
      if (members.includes(lead)) leadX.set(loop, left.get(lead.id) ?? 0)
    }
    componentStart = Math.max(...xs) + shift + cardWidth + COMPONENT_GAP
  }

  return left
}

/** Where a block of cards lands: where it wants, past what is already taken. */
function placeBlock(
  count: number,
  centre: number,
  cursor: number,
  blocked: readonly Span[],
  cardWidth: number
): number {
  const span = count * cardWidth + (count - 1) * COLUMN_GAP
  const start = Number.isFinite(centre) ? centre - span / 2 : 0
  let x = cursor === Number.NEGATIVE_INFINITY ? start : Math.max(start, cursor)
  for (const taken of [...blocked].sort((a, b) => a.from - b.from)) {
    if (x < taken.to && taken.from < x + span) x = taken.to + COLUMN_GAP
  }
  return x
}

/** The room one loop takes: its rounds wide, its deepest round tall. */
function reserve(
  loop: Loop | undefined,
  x: number,
  top: number,
  reserved: Map<number, Span[]>,
  cardWidth: number
): void {
  if (loop === undefined) return
  const span = { from: x, to: x + loop.rounds * (cardWidth + COLUMN_GAP) - COLUMN_GAP }
  for (let row = top; row < top + loop.depth; row++) {
    const held = reserved.get(row) ?? []
    held.push(span)
    reserved.set(row, held)
  }
}

/** Each node's spot by id, the first of a repeated id winning. */
function spotsById(nodes: readonly RunNode[], reading: LoopReading): Map<string, NodeSpot> {
  const spots = new Map<string, NodeSpot>()
  nodes.forEach((node, at) => {
    if (!spots.has(node.id)) spots.set(node.id, reading.spots[at] ?? { kind: 'spine' })
  })
  return spots
}

/** The node that opens each loop, which is where its first column stands. */
function leadingNodes(nodes: readonly RunNode[], reading: LoopReading): Map<number, RunNode> {
  const leads = new Map<number, RunNode>()
  nodes.forEach((node, at) => {
    const spot = reading.spots[at]
    if (spot === undefined || spot.kind !== 'loop') return
    if (spot.round === 0 && spot.index === 0 && !leads.has(spot.loop)) leads.set(spot.loop, node)
  })
  return leads
}

/** Weakly connected components, in order of the first node the record names. */
function componentOrder(
  nodes: readonly RunNode[],
  parentsOf: (node: RunNode) => readonly string[],
  index: Map<string, number>
): string[][] {
  const owner = new Map<string, string>(nodes.map((node) => [node.id, node.id]))
  const find = (id: string): string => {
    let root = id
    while ((owner.get(root) ?? root) !== root) root = owner.get(root) as string
    return root
  }
  for (const node of nodes) {
    for (const parent of parentsOf(node)) {
      const [a, b] = [find(node.id), find(parent)]
      // The earlier node keeps the name, so a component is known by the first
      // of its members the record holds.
      if (a === b) continue
      const [keep, folded] = (index.get(a) ?? 0) <= (index.get(b) ?? 0) ? [a, b] : [b, a]
      owner.set(folded, keep)
    }
  }
  const groups = new Map<string, string[]>()
  for (const node of nodes) {
    const root = find(node.id)
    const held = groups.get(root)
    if (held === undefined) groups.set(root, [node.id])
    else held.push(node.id)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (index.get(a) ?? 0) - (index.get(b) ?? 0))
    .map(([, members]) => members)
}

/**
 * How one edge travels, first match winning: sideways from one round to the
 * next, back along the band under a loop it is leaving, down a free lane when
 * it crosses cards, or straight from one row to the next.
 */
function routeFor(
  from: GraphCard,
  to: GraphCard,
  reading: LoopReading,
  cards: readonly GraphCard[],
  cardWidth: number
): EdgeRoute {
  const above = spotAt(reading, cards, from)
  const below = spotAt(reading, cards, to)
  if (above.kind === 'loop' && below.kind === 'loop' && below.loop === above.loop) {
    if (below.round > above.round) return { kind: 'across' }
  } else if (above.kind === 'loop' && to.layer > from.layer && to.x !== from.x) {
    return {
      kind: 'return',
      lane: freeLane(from.x + cardWidth / 2, from, to, cards, cardWidth),
      band: to.y - LAYER_GAP / 2
    }
  }
  const lane = channelFor(from, to, cards, cardWidth)
  return lane === undefined ? { kind: 'direct' } : { kind: 'lane', lane }
}

/** The spot of the node a card draws; cards and spots share the record's order. */
function spotAt(
  reading: LoopReading,
  cards: readonly GraphCard[],
  card: GraphCard
): NodeSpot {
  return reading.spots[cards.indexOf(card)] ?? { kind: 'spine' }
}

/**
 * Where an edge crossing more than one layer runs: the free x nearest the
 * straight line, clear of every card it would otherwise pass through.
 * Undefined when the two cards are one layer apart and nothing is in the way.
 */
function channelFor(
  from: GraphCard,
  to: GraphCard,
  cards: readonly GraphCard[],
  cardWidth: number
): number | undefined {
  if (to.layer - from.layer <= 1) return undefined
  if (!cards.some((card) => card.layer > from.layer && card.layer < to.layer)) return undefined
  return freeLane((from.x + to.x) / 2 + cardWidth / 2, from, to, cards, cardWidth)
}

/** The free x nearest `wanted`, clear of every card in the rows between two cards. */
function freeLane(
  wanted: number,
  from: GraphCard,
  to: GraphCard,
  cards: readonly GraphCard[],
  cardWidth: number
): number {
  const between = cards.filter((card) => card.layer > from.layer && card.layer < to.layer)
  if (between.length === 0) return wanted
  const blocked = merge(
    between.map((card) => [card.x - CHANNEL_CLEARANCE, card.x + cardWidth + CHANNEL_CLEARANCE])
  )
  const hit = blocked.find(([start, end]) => wanted >= start && wanted <= end)
  if (hit === undefined) return wanted
  return wanted - hit[0] <= hit[1] - wanted ? hit[0] : hit[1]
}

/** Overlapping spans folded into one, so either end of a hit is genuinely free. */
function merge(spans: [number, number][]): [number, number][] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const span of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else merged.push([...span])
  }
  return merged
}

/** The same route, translated with the drawing it belongs to. */
function moved(route: EdgeRoute, offset: { x: number; y: number }): EdgeRoute {
  switch (route.kind) {
    case 'lane':
      return { kind: 'lane', lane: route.lane + offset.x }
    case 'return':
      return { kind: 'return', lane: route.lane + offset.x, band: route.band + offset.y }
    default:
      return route
  }
}

/** The path one route draws between two cards. Every command is absolute. */
function pathFor(
  route: EdgeRoute,
  from: GraphCard,
  to: GraphCard,
  cardWidth: number,
  cardHeight: number
): string {
  switch (route.kind) {
    case 'across':
      return acrossPath(from, to, cardWidth, cardHeight)
    case 'return':
      return returnPath(route.lane, route.band, from, to, cardWidth, cardHeight)
    case 'lane':
      return lanePath(route.lane, from, to, cardWidth, cardHeight)
    default:
      return directPath(from, to, cardWidth, cardHeight)
  }
}

/** Out of the parent's bottom, into the child's top, straight or gently bent. */
function directPath(
  from: GraphCard,
  to: GraphCard,
  cardWidth: number,
  cardHeight: number
): string {
  const x1 = round(from.x + cardWidth / 2)
  const y1 = round(from.y + cardHeight)
  const x2 = round(to.x + cardWidth / 2)
  const y2 = round(to.y)
  if (x1 === x2) return `M${x1},${y1} L${x2},${y2}`
  const bend = round((y2 - y1) / 2)
  return `M${x1},${y1} C${x1},${y1 + bend} ${x2},${y2 - bend} ${x2},${y2}`
}

/**
 * An edge crossing layers makes its sideways move inside the empty bands
 * between them and runs its length down a clear lane, so it goes around the
 * cards rather than through them.
 */
function lanePath(
  lane: number,
  from: GraphCard,
  to: GraphCard,
  cardWidth: number,
  cardHeight: number
): string {
  const x1 = round(from.x + cardWidth / 2)
  const y1 = round(from.y + cardHeight)
  const x2 = round(to.x + cardWidth / 2)
  const y2 = round(to.y)
  const at = round(lane)
  const enter = round(y1 + LAYER_GAP)
  const leave = round(y2 - LAYER_GAP)
  const half = round(LAYER_GAP / 2)
  return (
    `M${x1},${y1} C${x1},${y1 + half} ${at},${enter - half} ${at},${enter} ` +
    `L${at},${leave} ` +
    `C${at},${leave + half} ${x2},${y2 - half} ${x2},${y2}`
  )
}

/**
 * Round to round: out of the parent's right side and into the child's left,
 * inside the empty band between the two columns. A round further off than the
 * next one goes round by the band above both cards rather than through what
 * stands between.
 */
function acrossPath(
  from: GraphCard,
  to: GraphCard,
  cardWidth: number,
  cardHeight: number
): string {
  const x1 = round(from.x + cardWidth)
  const y1 = round(from.y + cardHeight / 2)
  const x2 = round(to.x)
  const y2 = round(to.y + cardHeight / 2)
  if (to.x - (from.x + cardWidth) <= COLUMN_GAP + 0.5) {
    const middle = round((x1 + x2) / 2)
    return `M${x1},${y1} C${middle},${y1} ${middle},${y2} ${x2},${y2}`
  }
  const out = round(x1 + COLUMN_GAP / 2)
  const back = round(x2 - COLUMN_GAP / 2)
  const band = round(Math.min(from.y, to.y) - LAYER_GAP / 2)
  return `M${x1},${y1} L${out},${y1} L${out},${band} L${back},${band} L${back},${y2} L${x2},${y2}`
}

/**
 * Out of a loop: down the lane below the parent, back along the empty band
 * beneath the loop, and into the top of the node the run moved on to.
 */
function returnPath(
  lane: number,
  band: number,
  from: GraphCard,
  to: GraphCard,
  cardWidth: number,
  cardHeight: number
): string {
  const x1 = round(from.x + cardWidth / 2)
  const y1 = round(from.y + cardHeight)
  const x2 = round(to.x + cardWidth / 2)
  const y2 = round(to.y)
  const at = round(lane)
  const along = round(band)
  const half = round(LAYER_GAP / 2)
  const enter = round(Math.min(y1 + LAYER_GAP, along))
  const down =
    at === x1
      ? `M${x1},${y1} L${at},${enter}`
      : `M${x1},${y1} C${x1},${y1 + half} ${at},${enter - half} ${at},${enter}`
  if (at === x2) return `${down} L${x2},${y2}`
  const side = x2 < at ? -1 : 1
  const turn = round(Math.min(CORNER, Math.abs(x2 - at) / 2, (along - enter) / 2, (y2 - along) / 2))
  if (turn <= 0) return `${down} L${at},${along} L${x2},${along} L${x2},${y2}`
  return (
    `${down} L${at},${round(along - turn)} Q${at},${along} ${round(at + side * turn)},${along} ` +
    `L${round(x2 - side * turn)},${along} Q${x2},${along} ${x2},${round(along + turn)} ` +
    `L${x2},${y2}`
  )
}

/** Every x (`axis` 0) or y (`axis` 1) a path names, control points included. */
function coordsOf(d: string, axis: 0 | 1): number[] {
  return (d.match(/-?\d+(?:\.\d+)?/g) ?? [])
    .map(Number)
    .filter((_, at) => at % 2 === axis)
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function statusWord(node: RunNode): string {
  if (node.status === 'complete') return 'done'
  // The cut node reads as cut at a glance, while its neighbours keep their
  // checkmarks: the glyph is what carries that, never colour alone.
  if (node.status === 'interrupted') return '◌ interrupted'
  return node.status
}

function toneOf(node: RunNode): CardTone {
  switch (node.status) {
    case 'complete':
      return 'done'
    case 'running':
      return 'live'
    case 'pending':
      return 'wait'
    case 'failed':
      return 'bad'
    default:
      // blocked, stalled, paused, interrupted: stopped states share the amber
      // look, because none of them is a failure and none moves on its own.
      return 'parked'
  }
}

function verdictOf(node: RunNode): CardFace['verdict'] {
  if (typeof node.verdict !== 'object' || node.verdict === null) return undefined
  if (!('verdict' in node.verdict)) return undefined
  const text = String((node.verdict as { verdict: unknown }).verdict).replace(/-/g, ' ')
  return { text, tone: text === 'approved' ? 'ok' : 'warn' }
}

function firstLine(text: string): string {
  return text.split('\n')[0]
}
