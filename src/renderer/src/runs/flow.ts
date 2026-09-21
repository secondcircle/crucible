import type { RunNode } from '../../../shared/workflows/run'

/**
 * What the run graph draws: for each node, the nodes it ran after, as the
 * record declares them. A file another node wrote is never one of these —
 * dataflow is the artifact rail's.
 *
 * A node that has not started ran after nothing: its plan's forecast would
 * put it wherever the workflow guessed, mid-graph, above work that has
 * already happened. The planned tail is chained in plan order instead,
 * hanging off the node running now — or off the last that ran.
 */
export function readFlow(nodes: readonly RunNode[]): ReadonlyMap<RunNode, readonly string[]> {
  const started = (node: RunNode): boolean => node.status !== 'pending'
  const held = new Set(nodes.map((node) => node.id))
  const walked = nodes.filter(started)
  const planned = nodes.filter((node) => !started(node))
  // An id a started record also carries is not an unstarted node, whatever a
  // second record under that id says.
  const startedIds = new Set(walked.map((node) => node.id))
  const unstarted = new Set(
    planned.map((node) => node.id).filter((id) => !startedIds.has(id))
  )

  const flow = new Map<RunNode, readonly string[]>()
  for (const node of walked) {
    flow.set(node, [
      ...new Set(
        node.parents.filter(
          (parent) => parent !== node.id && held.has(parent) && !unstarted.has(parent)
        )
      )
    ])
  }

  const anchor = lastToRun(walked.filter((node) => node.status === 'running')) ?? lastToRun(walked)
  planned.forEach((node, at) => {
    const after = at === 0 ? anchor?.id : planned[at - 1].id
    flow.set(node, after === undefined || after === node.id ? [] : [after])
  })
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

/** The last of them to start, ties going to the later record. */
function lastToRun(nodes: readonly RunNode[]): RunNode | undefined {
  return nodes.reduce<RunNode | undefined>(
    (held, node) => (held === undefined || !ranBefore(node, held) ? node : held),
    undefined
  )
}

function ranBefore(node: RunNode, than: RunNode): boolean {
  if (node.startedAt === undefined) return false
  if (than.startedAt === undefined) return true
  return node.startedAt < than.startedAt
}
