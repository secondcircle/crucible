import { artifactName } from '../../../shared/workflows/artifacts'
import type { RunNode, RunRecord } from '../../../shared/workflows/run'

// The artifact rail's whole model, derived from the record and nothing else:
// what the run took in, what it declared, what has landed, and who read it.
// The graph on the left is the schedule; this is the dataflow.

export type RailState = 'written' | 'live' | 'parked' | 'pending' | 'never'

export interface RailRow {
  /** The absolute path, which is also the row's identity and its lookup key. */
  readonly path: string
  readonly name: string
  readonly desc?: string
  readonly kind: 'input' | 'produced'
  /** The node that declared it; absent for a kickoff input. */
  readonly producer?: string
  /** Ids of the nodes whose `reads` name this path, in node order. */
  readonly readers: readonly string[]
  readonly state: RailState
  readonly writtenAt?: string
  /** The producing node's status, for the flow line of an unwritten row. */
  readonly producerStatus?: RunNode['status']
}

export interface RailModel {
  readonly inputs: readonly RailRow[]
  readonly produced: readonly RailRow[]
  /** Declared run-written paths, and how many of them have landed. */
  readonly declared: number
  readonly written: number
}

export function railOf(run: RunRecord): RailModel {
  const readersOf = (path: string): string[] => {
    const found: string[] = []
    for (const node of run.nodes) {
      if (found.includes(node.id)) continue
      if (node.reads.some((read) => read.path === path)) found.push(node.id)
    }
    return found
  }

  const inputs: RailRow[] = Object.values(run.inputs).map((path) => {
    const desc = descOf(run, path)
    return {
      path,
      name: artifactName(path),
      ...(desc === undefined ? {} : { desc }),
      kind: 'input' as const,
      readers: readersOf(path),
      state: 'written' as const
    }
  })

  // First appearance in the record decides the order, and the record keeps a
  // node's place when a ghost becomes the real thing, so a row never moves.
  const produced = new Map<string, RailRow>()
  for (const node of run.nodes) {
    for (const artifact of node.artifacts) {
      const row: RailRow = {
        path: artifact.path,
        name: artifactName(artifact.path),
        desc: artifact.desc,
        kind: 'produced',
        producer: node.id,
        readers: readersOf(artifact.path),
        state: stateOf(run, node, artifact.writtenAt !== undefined),
        ...(artifact.writtenAt === undefined ? {} : { writtenAt: artifact.writtenAt }),
        producerStatus: node.status
      }
      const held = produced.get(artifact.path)
      produced.set(artifact.path, held === undefined ? row : furthest(held, row))
    }
  }

  const rows = [...produced.values()]
  return {
    inputs,
    produced: rows,
    declared: rows.length,
    written: rows.filter((row) => row.state === 'written').length
  }
}

/** The row for one path, whichever group it sits in. */
export function rowFor(rail: RailModel, path: string): RailRow | undefined {
  return [...rail.inputs, ...rail.produced].find((candidate) => candidate.path === path)
}

// Several node records can declare the same path (a revision re-declares its
// outputs), and the rail shows one row backed by the furthest copy.
function furthest(held: RailRow, next: RailRow): RailRow {
  if (held.state === 'written' && next.state !== 'written') return held
  if (next.state === 'written' && held.state !== 'written') return next
  if (held.state === 'written' && next.state === 'written') {
    return (next.writtenAt ?? '') >= (held.writtenAt ?? '') ? next : held
  }
  // Both unwritten: the latest declaration is the one still being worked on.
  return next
}

// A written artifact is one the engine stamped, or one carried by a node that
// settled clean — records written before the stamp existed only ever recorded
// artifacts on completion.
function stateOf(run: RunRecord, node: RunNode, stamped: boolean): RailState {
  if (stamped || node.status === 'complete') return 'written'
  if (node.status === 'failed') return 'never'
  if (run.status === 'cancelled' || run.status === 'failed') return 'never'
  if (node.status === 'running') return 'live'
  if (node.status === 'pending') return 'pending'
  // blocked, stalled, paused: the node is parked and owes the file still.
  return 'parked'
}

function descOf(run: RunRecord, path: string): string | undefined {
  const named = Object.entries(run.inputs).find(([, value]) => value === path)?.[0]
  if (named === undefined) return undefined
  const described = run.inputDescs?.[named]
  return described === undefined || described.trim() === '' ? undefined : described
}
