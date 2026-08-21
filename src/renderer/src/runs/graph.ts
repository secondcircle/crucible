import type { RunNode } from '../../../shared/workflows/run'

// Layered, top-down (Q14): a node sits one layer below its deepest parent,
// so parents are always above their children and revise nodes appear as
// appended layers. Order within a layer follows the run record's own order,
// which is execution order.

export function layerNodes(nodes: readonly RunNode[]): readonly (readonly RunNode[])[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const depths = new Map<string, number>()

  function depthOf(node: RunNode, walking: Set<string>): number {
    const known = depths.get(node.id)
    if (known !== undefined) return known
    // A cycle cannot happen in a real run record; the guard keeps a corrupt
    // one from hanging the window.
    if (walking.has(node.id)) return 0
    walking.add(node.id)
    const parents = node.parents
      .map((parent) => byId.get(parent))
      .filter((parent): parent is RunNode => parent !== undefined)
    const depth =
      parents.length === 0
        ? 0
        : 1 + Math.max(...parents.map((parent) => depthOf(parent, walking)))
    depths.set(node.id, depth)
    return depth
  }

  const layers: RunNode[][] = []
  for (const node of nodes) {
    const depth = depthOf(node, new Set())
    while (layers.length <= depth) layers.push([])
    layers[depth].push(node)
  }
  return layers.filter((layer) => layer.length > 0)
}
