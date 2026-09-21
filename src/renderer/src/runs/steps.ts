import { baseNodeId, type RunNode } from '../../../shared/workflows/run'
import { runOrder } from './flow'
import { baseName } from './loops'

/**
 * The step a node's id is about: what is left once the role leading the id
 * and the round ending it are taken off, so `builder-account-shell` and
 * `review-account-shell-1` are both about `account-shell`. Undefined for an
 * id that names only a role — `analyst`, `review-1` — which is about the run
 * rather than about one piece of work.
 */
export function stepName(id: string): string | undefined {
  const base = baseName(baseNodeId(id))
  const at = base.indexOf('-')
  if (at <= 0 || at === base.length - 1) return undefined
  return base.slice(at + 1)
}

/** A stretch of consecutive nodes about one step, drawn inside one outline. */
export interface StepBlock {
  /** The step's own name, as the ids give it. */
  readonly name: string
  /** Its nodes, as positions in the record, in the order they ran. */
  readonly members: readonly number[]
}

/**
 * The step blocks a record holds, in the order they ran. Read from ids alone,
 * like a loop: a workflow declares nothing to get the picture.
 *
 * Two nodes about one step are not yet a step block — several rounds of one
 * review are a loop, not a piece of work, and a lone id that happens to carry
 * a suffix is neither. A block is a stretch of at least two nodes whose ids
 * name the same step in at least two different roles, which is the shape of
 * work being built and reviewed.
 */
export function readSteps(nodes: readonly RunNode[]): readonly StepBlock[] {
  const blocks: StepBlock[] = []
  let open: { name: string; members: number[]; roles: Set<string> } | undefined

  const close = (): void => {
    if (open !== undefined && open.members.length >= 2 && open.roles.size >= 2) {
      blocks.push({ name: open.name, members: open.members })
    }
    open = undefined
  }

  for (const at of runOrder(nodes)) {
    const name = stepName(nodes[at].id)
    if (name === undefined) {
      close()
      continue
    }
    if (open?.name !== name) {
      close()
      open = { name, members: [], roles: new Set() }
    }
    open.members.push(at)
    open.roles.add(roleOf(nodes[at].id))
  }
  close()
  return blocks
}

/** What the node does in its step: the first segment of its id. */
function roleOf(id: string): string {
  const base = baseName(baseNodeId(id))
  return base.slice(0, base.indexOf('-'))
}
