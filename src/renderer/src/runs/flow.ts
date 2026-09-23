import type { RunNode } from '../../../shared/workflows/run'

/**
 * What the run graph draws: for each node, the nodes it ran after, as the
 * record declares them. A file another node wrote is never one of these —
 * dataflow is the artifact rail's.
 *
 * A node that has not started is drawn from the parents its record holds,
 * the plan's forecast until it starts, so a planned fan-out stays a fan-out.
 * The one edge left out is a started node's to a parent nobody has started:
 * it would climb out of the planned work into work already done.
 */
export function readFlow(nodes: readonly RunNode[]): ReadonlyMap<RunNode, readonly string[]> {
  const held = new Set(nodes.map((node) => node.id))
  // An id a started record also carries is not an unstarted node, whatever a
  // second record under that id says.
  const startedIds = new Set(nodes.filter(started).map((node) => node.id))
  const unstarted = new Set(
    nodes
      .filter((node) => !started(node))
      .map((node) => node.id)
      .filter((id) => !startedIds.has(id))
  )

  const flow = new Map<RunNode, readonly string[]>()
  for (const node of nodes) {
    flow.set(node, [
      ...new Set(
        node.parents.filter(
          (parent) =>
            parent !== node.id &&
            held.has(parent) &&
            !(started(node) && unstarted.has(parent))
        )
      )
    ])
  }
  return flow
}

/**
 * The nodes in the order they ran, as positions in the record: each after
 * everything it ran after, and otherwise by the clock. A record whose edges
 * cycle still comes out whole, in the order it was written.
 */
export function runOrder(nodes: readonly RunNode[]): number[] {
  const flow = readFlow(nodes)
  const walked = new Set<string>()
  const ready = (node: RunNode): boolean =>
    (flow.get(node) ?? []).every((parent) => walked.has(parent))

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

function started(node: RunNode): boolean {
  return node.status !== 'pending'
}
