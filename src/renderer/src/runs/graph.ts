import type { RunNode } from '../../../shared/workflows/run'
import { money, nodeDuration, shortModel } from './format'

// The run graph's geometry: a pure function from a run record's nodes to
// positioned cards and drawn edges. Layered top-down, longest-path depth, one
// column per root, independent subtrees side by side. The same record always
// yields the identical picture — that determinism is what lets the graph be
// read at a glance and what these numbers are tested on.

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
  /** Longest-path depth from the roots. */
  readonly layer: number
  readonly x: number
  readonly y: number
}

export interface GraphEdge {
  readonly from: string
  readonly to: string
  /** SVG path data: out of the parent's bottom, into the child's top. */
  readonly d: string
}

export interface GraphLayout {
  readonly cards: readonly GraphCard[]
  readonly edges: readonly GraphEdge[]
  readonly cardWidth: number
  readonly cardHeight: number
  readonly width: number
  readonly height: number
}

/**
 * The graph of one run record: every node once, every edge its `parents` name
 * that the record can honor. A parent id naming no node is skipped rather
 * than drawn to nothing.
 */
export function layOutGraph(nodes: readonly RunNode[]): GraphLayout {
  const index = new Map(nodes.map((node, at) => [node.id, at]))
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const cardWidth = widthFor(nodes)
  const cardHeight = heightFor(nodes)

  // One edge per parent, whatever the record repeats, and never one to a node
  // the record no longer holds or to the node itself.
  const parentsOf = (node: RunNode): readonly string[] => [
    ...new Set(node.parents.filter((parent) => parent !== node.id && index.has(parent)))
  ]

  const layers = depths(nodes, parentsOf)
  const order = componentOrder(nodes, parentsOf, index)

  // Left edge of every card, laid out one component at a time so independent
  // subtrees never fight over the same columns.
  const left = new Map<string, number>()
  let componentStart = 0
  for (const component of order) {
    const members = component.map((id) => byId.get(id) as RunNode)
    const deepest = Math.max(...members.map((node) => layers.get(node.id) ?? 0))
    for (let layer = 0; layer <= deepest; layer++) {
      const row = members.filter((node) => layers.get(node.id) === layer)
      placeRow(row, parentsOf, left, cardWidth)
    }
    const xs = members.map((node) => left.get(node.id) ?? 0)
    const shift = componentStart - Math.min(...xs)
    for (const node of members) left.set(node.id, (left.get(node.id) ?? 0) + shift)
    componentStart = Math.max(...xs) + shift + cardWidth + COMPONENT_GAP
  }

  const cards: GraphCard[] = nodes.map((node) => {
    const layer = layers.get(node.id) ?? 0
    return {
      node,
      id: node.id,
      layer,
      x: left.get(node.id) ?? 0,
      y: layer * (cardHeight + LAYER_GAP)
    }
  })
  const cardOf = new Map(cards.map((card) => [card.id, card]))

  // Channels first, positions after: a bow to the left of the leftmost card
  // moves the whole drawing right, and a path string cannot be re-read.
  const routes = nodes.flatMap((node) =>
    parentsOf(node).map((parent) => {
      const from = cardOf.get(parent) as GraphCard
      const to = cardOf.get(node.id) as GraphCard
      return { from, to, channel: channelFor(from, to, cards, cardWidth) }
    })
  )

  const originX = Math.min(
    0,
    ...routes.map((route) => (route.channel === undefined ? 0 : route.channel))
  )
  const offset = CANVAS_MARGIN - originX
  const placed = cards.map((card) => ({ ...card, x: card.x + offset, y: card.y + CANVAS_MARGIN }))
  const placedOf = new Map(placed.map((card) => [card.id, card]))

  const edges: GraphEdge[] = routes.map((route) => ({
    from: route.from.id,
    to: route.to.id,
    d: pathFor(
      placedOf.get(route.from.id) as GraphCard,
      placedOf.get(route.to.id) as GraphCard,
      route.channel === undefined ? undefined : route.channel + offset,
      cardWidth,
      cardHeight
    )
  }))

  const rightmost = placed.length === 0 ? 0 : Math.max(...placed.map((card) => card.x + cardWidth))
  const lowest = placed.length === 0 ? 0 : Math.max(...placed.map((card) => card.y + cardHeight))
  const bows = routes
    .map((route) => (route.channel === undefined ? 0 : route.channel + offset))
    .filter((channel) => channel > 0)
  return {
    cards: placed,
    edges,
    cardWidth,
    cardHeight,
    width: Math.max(rightmost, ...bows) + CANVAS_MARGIN,
    height: lowest + CANVAS_MARGIN
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
    of('failed') === 0 ? '' : `${of('failed')} failed`
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

/** Longest-path depth, so every parent sits in a strictly shallower layer. */
function depths(
  nodes: readonly RunNode[],
  parentsOf: (node: RunNode) => readonly string[]
): Map<string, number> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const known = new Map<string, number>()

  function depthOf(node: RunNode, walking: Set<string>): number {
    const held = known.get(node.id)
    if (held !== undefined) return held
    // A cycle cannot happen in a real run record; the guard keeps a corrupt
    // one from hanging the window.
    if (walking.has(node.id)) return 0
    walking.add(node.id)
    const parents = parentsOf(node)
    const depth =
      parents.length === 0
        ? 0
        : 1 + Math.max(...parents.map((id) => depthOf(byId.get(id) as RunNode, walking)))
    walking.delete(node.id)
    known.set(node.id, depth)
    return depth
  }

  for (const node of nodes) depthOf(node, new Set())
  return known
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
 * One layer's cards, placed under their parents: siblings of one parent form
 * a block centred on it, a fan-in's child lands under the spread of its
 * parents, and record order settles every tie. Nothing overlaps: a block that
 * wants room already taken starts where the last one ended.
 */
function placeRow(
  row: readonly RunNode[],
  parentsOf: (node: RunNode) => readonly string[],
  left: Map<string, number>,
  cardWidth: number
): void {
  const wanted = new Map<string, number>()
  for (const node of row) {
    const parents = parentsOf(node)
      .map((parent) => left.get(parent))
      .filter((x): x is number => x !== undefined)
    // A root wants nothing in particular, so it packs to the left in record
    // order and starts its own column.
    wanted.set(
      node.id,
      parents.length === 0
        ? Number.NEGATIVE_INFINITY
        : parents.reduce((sum, x) => sum + x + cardWidth / 2, 0) / parents.length
    )
  }
  // Stable, so record order — which is execution order — settles every tie
  // and the picture holds still as the run grows.
  const ordered = [...row].sort((a, b) => {
    const wantsA = wanted.get(a.id) as number
    const wantsB = wanted.get(b.id) as number
    if (wantsA === wantsB) return 0
    return wantsA < wantsB ? -1 : 1
  })

  let cursor = Number.NEGATIVE_INFINITY
  for (let at = 0; at < ordered.length; ) {
    // Cards wanting the same spot are one parent's siblings; they sit
    // adjacent, and the block as a whole is centred where they wanted to be.
    const centre = wanted.get(ordered[at].id) as number
    let end = at
    while (end < ordered.length && wanted.get(ordered[end].id) === centre) end += 1
    const block = ordered.slice(at, end)
    const span = block.length * cardWidth + (block.length - 1) * COLUMN_GAP
    const start = Number.isFinite(centre) ? centre - span / 2 : 0
    let x = cursor === Number.NEGATIVE_INFINITY ? start : Math.max(start, cursor)
    for (const node of block) {
      left.set(node.id, x)
      x += cardWidth + COLUMN_GAP
    }
    cursor = x
    at = end
  }
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
  const between = cards.filter((card) => card.layer > from.layer && card.layer < to.layer)
  if (between.length === 0) return undefined

  const blocked = merge(
    between.map((card) => [card.x - CHANNEL_CLEARANCE, card.x + cardWidth + CHANNEL_CLEARANCE])
  )
  const wanted = (from.x + to.x) / 2 + cardWidth / 2
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

/**
 * Out of the parent's bottom, into the child's top. An edge crossing layers
 * makes its sideways move inside the empty bands between them and runs its
 * length down a clear channel, so it goes around the cards rather than
 * through them.
 */
function pathFor(
  from: GraphCard,
  to: GraphCard,
  channel: number | undefined,
  cardWidth: number,
  cardHeight: number
): string {
  const x1 = round(from.x + cardWidth / 2)
  const y1 = round(from.y + cardHeight)
  const x2 = round(to.x + cardWidth / 2)
  const y2 = round(to.y)
  if (channel === undefined) {
    if (x1 === x2) return `M${x1},${y1} L${x2},${y2}`
    const bend = round((y2 - y1) / 2)
    return `M${x1},${y1} C${x1},${y1 + bend} ${x2},${y2 - bend} ${x2},${y2}`
  }
  const lane = round(channel)
  const enter = round(y1 + LAYER_GAP)
  const leave = round(y2 - LAYER_GAP)
  const half = round(LAYER_GAP / 2)
  return (
    `M${x1},${y1} C${x1},${y1 + half} ${lane},${enter - half} ${lane},${enter} ` +
    `L${lane},${leave} ` +
    `C${lane},${leave + half} ${x2},${y2 - half} ${x2},${y2}`
  )
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function statusWord(node: RunNode): string {
  return node.status === 'complete' ? 'done' : node.status
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
      // blocked, stalled, paused: parked states share the amber look.
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
