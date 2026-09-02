import type { RunNode } from '../../../shared/workflows/run'

// Where the run graph's loops come from: the ids the record already holds and
// the order it holds them in. Nothing declares a loop — no field on a node, no
// workflow API — so the same record read anywhere shows the same loops. This
// module is the only place in the app that reads meaning out of a node id, and
// it says nothing about geometry: rows, columns and pixels are the layout's
// business.

/** The digits after a final hyphen, which is all a round number ever is. */
const ROUND = /-(\d+)$/

/**
 * The round number an id carries: the digits after its last hyphen.
 * `review-2` is round 2; `builder` and `review-1·r1` carry none, because a
 * revision is the engine's replay of one node and not a round of a loop.
 */
export function roundNumber(id: string): number | undefined {
  const found = ROUND.exec(id)
  return found === null ? undefined : Number(found[1])
}

/** What precedes the round number, or the whole id when there is none. */
export function baseName(id: string): string {
  return id.replace(ROUND, '')
}

/** Where one node of the record sits once the loops have been read. */
export type NodeSpot =
  | { readonly kind: 'spine' }
  | {
      readonly kind: 'loop'
      /** Index into `LoopReading.loops`. */
      readonly loop: number
      /** 0-based round, which is the column this node draws in. */
      readonly round: number
      /** 0-based position within the round, which is its row inside the loop. */
      readonly index: number
    }

/** One inferred loop's shape. Nothing here is drawn; this is what it measures. */
export interface Loop {
  /** The base name whose recurrence opens each round. */
  readonly leader: string
  /** Rounds held, which is the loop's width in columns. Never below 2. */
  readonly rounds: number
  /** The most nodes any one round holds, which is its depth in rows. Never below 1. */
  readonly depth: number
}

/**
 * Every node's spot, positionally aligned with the array that was read, plus
 * the shape of each loop found. `spots[at]` describes `nodes[at]`; reading it
 * against any other array is a mistake the types cannot catch.
 */
export interface LoopReading {
  readonly spots: readonly NodeSpot[]
  /** Indexed by `NodeSpot.loop`, in the order the loops open. */
  readonly loops: readonly Loop[]
}

const SPINE: NodeSpot = { kind: 'spine' }

/** A loop still being read: its rounds hold indices into the record. */
interface OpenLoop {
  readonly leader: string
  /** The highest round number this leading name carries anywhere in the record. */
  readonly highest: number | undefined
  /** The round number of the occurrence that opened the round in progress. */
  current: number | undefined
  /** Indices into the record, one array per round, in record order. */
  readonly rounds: number[][]
  /** Base names already seen inside this loop, which is what admits a follower. */
  readonly bases: Set<string>
}

/**
 * The loops a record holds, inferred from ids alone and from their order.
 * Reading nodes in record order: the first node whose base name carries two
 * or more round numbers in this record opens a loop and leads it; each later
 * occurrence of the leading name opens the next round; any other node joins
 * the round in progress while the loop is short of its last round, and in the
 * last round only if its base name has already been seen inside this loop.
 * A node neither rule admits closes the loop and resumes the spine, opening
 * the next loop at once if its own base name recurs.
 */
export function readLoops(nodes: readonly RunNode[]): LoopReading {
  const numbers = roundNumbers(nodes)
  const spots: NodeSpot[] = nodes.map(() => SPINE)
  const loops: Loop[] = []
  let open: OpenLoop | undefined

  // A leading name whose later rounds never arrive is not a loop, whatever the
  // rest of the record says: its nodes stay on the spine and draw as today.
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
      // Mid-loop every follower belongs to the round in progress; in the last
      // round only a name the loop has already shown does, so the node that
      // moves the run on ends the loop instead of joining it.
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

/** Every round number each base name carries in this record. */
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
