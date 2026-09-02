import type { RunNode } from '../../../shared/workflows/run'

const ROUND = /-(\d+)$/

export function roundNumber(id: string): number | undefined {
  const found = ROUND.exec(id)
  return found === null ? undefined : Number(found[1])
}

export function baseName(id: string): string {
  return id.replace(ROUND, '')
}

export type NodeSpot =
  | { readonly kind: 'spine' }
  | {
      readonly kind: 'loop'
      readonly loop: number
      readonly round: number
      readonly index: number
    }

export interface Loop {
  readonly leader: string
  readonly rounds: number
  readonly depth: number
}

export interface LoopReading {
  readonly spots: readonly NodeSpot[]
  readonly loops: readonly Loop[]
}

const SPINE: NodeSpot = { kind: 'spine' }

interface OpenLoop {
  readonly leader: string
  readonly highest: number | undefined
  current: number | undefined
  readonly rounds: number[][]
  readonly bases: Set<string>
}

export function readLoops(nodes: readonly RunNode[]): LoopReading {
  const order = runOrder(nodes)
  const read = readAlong(order.map((at) => nodes[at]))
  const spots: NodeSpot[] = nodes.map(() => SPINE)
  order.forEach((at, place) => {
    spots[at] = read.spots[place]
  })
  return { spots, loops: read.loops }
}

function runOrder(nodes: readonly RunNode[]): number[] {
  const held = new Set(nodes.map((node) => node.id))
  const walked = new Set<string>()
  const ready = (node: RunNode): boolean =>
    node.parents.every(
      (parent) => parent === node.id || !held.has(parent) || walked.has(parent)
    )

  const taken = nodes.map(() => false)
  const order: number[] = []
  while (order.length < nodes.length) {
    let pick = -1
    let first = -1
    for (let at = 0; at < nodes.length; at++) {
      if (taken[at]) continue
      if (first === -1) first = at
      if (!ready(nodes[at])) continue
      if (pick === -1 || ranBefore(nodes[at], nodes[pick])) pick = at
    }
    const next = pick === -1 ? first : pick
    taken[next] = true
    walked.add(nodes[next].id)
    order.push(next)
  }
  return order
}

function ranBefore(node: RunNode, than: RunNode): boolean {
  if (node.startedAt === undefined) return false
  if (than.startedAt === undefined) return true
  return node.startedAt < than.startedAt
}

function readAlong(nodes: readonly RunNode[]): LoopReading {
  const numbers = roundNumbers(nodes)
  const spots: NodeSpot[] = nodes.map(() => SPINE)
  const loops: Loop[] = []
  let open: OpenLoop | undefined

  const close = (): void => {
    if (open === undefined) return
    if (open.rounds.length >= 2) {
      const loop = loops.length
      open.rounds.forEach((round, at) =>
        round.forEach((held, index) => {
          spots[held] = { kind: 'loop', loop, round: at, index }
        })
      )
      loops.push({
        leader: open.leader,
        rounds: open.rounds.length,
        depth: Math.max(...open.rounds.map((round) => round.length))
      })
    }
    open = undefined
  }

  nodes.forEach((node, at) => {
    const base = baseName(node.id)
    if (open !== undefined) {
      if (base === open.leader) {
        open.rounds.push([at])
        open.current = roundNumber(node.id)
        open.bases.add(base)
        return
      }
      if (open.current !== open.highest || open.bases.has(base)) {
        open.rounds[open.rounds.length - 1].push(at)
        open.bases.add(base)
        return
      }
      close()
    }
    const rounds = numbers.get(base)
    if (rounds === undefined || rounds.size < 2) return
    open = {
      leader: base,
      highest: Math.max(...rounds),
      current: roundNumber(node.id),
      rounds: [[at]],
      bases: new Set([base])
    }
  })
  close()

  return { spots, loops }
}

function roundNumbers(nodes: readonly RunNode[]): Map<string, Set<number>> {
  const numbers = new Map<string, Set<number>>()
  for (const node of nodes) {
    const round = roundNumber(node.id)
    if (round === undefined) continue
    const base = baseName(node.id)
    const held = numbers.get(base) ?? new Set<number>()
    held.add(round)
    numbers.set(base, held)
  }
  return numbers
}
