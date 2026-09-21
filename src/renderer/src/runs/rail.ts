import { artifactName } from '../../../shared/workflows/artifacts'
import type { RunArtifact, RunNode, RunRecord } from '../../../shared/workflows/run'

// The artifact rail's whole model, derived from the record and nothing else:
// what the run took in, what it declared, what has landed, and who read it.
// The graph on the left is the schedule; this is the dataflow.
//
// Two scopes, one row: the picked node's own files, or the whole run's list.
// A row is built the same way either way, so a file says the same thing about
// itself whichever scope is showing it.

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

/** Which files the rail is showing, in the switch's own words. */
export type RailScope = 'this-node' | 'whole-run'

/** The whole run: what was handed in, then everything the run declared. */
export interface RunRail {
  readonly scope: 'whole-run'
  readonly inputs: readonly RailRow[]
  readonly produced: readonly RailRow[]
  /** Declared run-written paths, and how many of them have landed. */
  readonly declared: number
  readonly written: number
}

/** One node: what it was required to write, then what its prompt named. */
export interface NodeRail {
  readonly scope: 'this-node'
  /** The node the rail follows, as the headings name it. */
  readonly node: string
  readonly made: readonly RailRow[]
  readonly took: readonly RailRow[]
  /** The node's own declared outputs, and how many of them have landed. */
  readonly declared: number
  readonly written: number
}

export type RailModel = RunRail | NodeRail

/**
 * The rail model for one snapshot of one run.
 *
 * `placed` is the order this same run's rows were last given, oldest first.
 * The record alone cannot say when a row first appeared. A node's declared
 * outputs read the same whether the plan placed them at kickoff or the node
 * declared them when it started, so the caller carries the placement order
 * forward and passes it back: a row never moves once placed.
 * Pass nothing and the record's own node order decides, which is all a rail
 * opened mid-flight can honor.
 */
export function railOf(run: RunRecord, placed: readonly string[] = []): RunRail {
  const rows = inPlacedOrder(producedRows(run), placed)
  return {
    scope: 'whole-run',
    inputs: inputRows(run),
    produced: rows,
    declared: rows.length,
    written: writtenCount(rows)
  }
}

/**
 * The rail model for one node of one run: the outputs that node was required
 * to write, then the files its prompt named as inputs.
 *
 * Both lists come from the node's record and nothing else — a file the node
 * read on its own initiative was never declared, so it is not the node's to
 * show. A made row is the node's own record of it, so a record a revision
 * superseded says what that attempt did rather than what the revision went on
 * to do; a took row is the run-wide row for the path, because who wrote a
 * file and who else read it are facts about the run.
 */
export function nodeRailOf(run: RunRecord, node: RunNode): NodeRail {
  const made = node.artifacts.map((artifact) => producedRow(run, node, artifact))
  const produced = producedRows(run)
  const inputs = new Map(inputRows(run).map((row) => [row.path, row]))
  const took = node.reads.map(
    (read) => produced.get(read.path) ?? inputs.get(read.path) ?? outsideRow(run, read)
  )
  return {
    scope: 'this-node',
    node: node.id,
    made,
    took,
    declared: made.length,
    written: writtenCount(made)
  }
}

/** Ids of the nodes whose `reads` name this path, in node order. */
function readersOf(run: RunRecord, path: string): string[] {
  const found: string[] = []
  for (const node of run.nodes) {
    if (found.includes(node.id)) continue
    if (node.reads.some((read) => read.path === path)) found.push(node.id)
  }
  return found
}

function inputRows(run: RunRecord): RailRow[] {
  return Object.values(run.inputs).map((path) => {
    const desc = descOf(run, path)
    return {
      path,
      name: artifactName(path),
      ...(desc === undefined ? {} : { desc }),
      kind: 'input' as const,
      readers: readersOf(run, path),
      state: 'written' as const
    }
  })
}

// One row per path, backed by the furthest copy that declares it. Building
// by node order puts paths never seen before in record order, which is plan
// order for the ghosts standing at kickoff.
function producedRows(run: RunRecord): Map<string, RailRow> {
  const produced = new Map<string, RailRow>()
  for (const node of run.nodes) {
    for (const artifact of node.artifacts) {
      const row = producedRow(run, node, artifact)
      const held = produced.get(artifact.path)
      produced.set(artifact.path, held === undefined ? row : furthest(held, row))
    }
  }
  return produced
}

function producedRow(run: RunRecord, node: RunNode, artifact: RunArtifact): RailRow {
  return {
    path: artifact.path,
    name: artifactName(artifact.path),
    desc: artifact.desc,
    kind: 'produced',
    producer: node.id,
    readers: readersOf(run, artifact.path),
    state: stateOf(run, node, artifact.writtenAt !== undefined),
    ...(artifact.writtenAt === undefined ? {} : { writtenAt: artifact.writtenAt }),
    producerStatus: node.status
  }
}

// A declared read of a file the run neither took in at kickoff nor wrote for
// itself: it reached the node from outside the run, which is what an input is.
function outsideRow(run: RunRecord, read: RunArtifact): RailRow {
  return {
    path: read.path,
    name: artifactName(read.path),
    desc: read.desc,
    kind: 'input',
    readers: readersOf(run, read.path),
    state: 'written'
  }
}

function writtenCount(rows: readonly RailRow[]): number {
  return rows.filter((row) => row.state === 'written').length
}

// Rows keep the slot they were placed in: every remembered path first, in the
// order it was placed, then whatever the record has grown since, in node
// order. A path the record no longer names (a pruned ghost's) drops out and
// takes its slot with it.
function inPlacedOrder(produced: Map<string, RailRow>, placed: readonly string[]): RailRow[] {
  const rows: RailRow[] = []
  const taken = new Set<string>()
  for (const path of placed) {
    const row = produced.get(path)
    if (row === undefined || taken.has(path)) continue
    rows.push(row)
    taken.add(path)
  }
  for (const [path, row] of produced) {
    if (taken.has(path)) continue
    rows.push(row)
    taken.add(path)
  }
  return rows
}

/** The row for one path, whichever group it sits in. */
export function rowFor(rail: RunRail, path: string): RailRow | undefined {
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
