import type {
  CatalogEntry,
  CatalogSnapshot,
  PlannedModel,
  ReadAgent,
  ReadingState,
  SourceQuote,
  WorkflowReading
} from './catalog'
import { sameReader, type CatalogReaderSettings } from './catalog-settings'
import { ENGINE_DEFAULT_MODEL } from './node-model'
import { runCost, runIsLive, type RunRecord } from './run'

// What the catalog's surfaces derive from its snapshot and the run records,
// kept pure so every rule about provenance is provable without a window.

/** Where a fact on the page came from. */
export type Provenance = 'manifest' | 'reading' | 'runs'

// An agent's model as the page states it. The engine default is its own case
// so it can never be shown as a choice the workflow made, and a model the
// manifest's plan forecasts outranks whatever the reading said.
export type ModelFact =
  | {
      readonly kind: 'named'
      readonly model: string
      readonly from: Exclude<Provenance, 'runs'>
      /** Where the reading found it written, when the reading is the source. */
      readonly quote?: SourceQuote
      /** What the reading said instead, where the plan overruled it. */
      readonly overruled?: string
    }
  | {
      readonly kind: 'default'
      readonly model: string
      readonly from: Exclude<Provenance, 'runs'>
      readonly overruled?: string
    }

export function modelFact(agent: ReadAgent, plan: readonly PlannedModel[] | undefined): ModelFact {
  const read = agent.model?.value
  const planned = (plan ?? []).filter((node) => agent.nodes.some((pattern) => nodeMatches(pattern, node.id)))
  const forecast = planned[0]
  if (forecast !== undefined) {
    const model = forecast.model ?? ENGINE_DEFAULT_MODEL
    const overruled = read !== undefined && read !== model ? { overruled: read } : {}
    return forecast.model === undefined
      ? { kind: 'default', model, from: 'manifest', ...overruled }
      : { kind: 'named', model, from: 'manifest', ...overruled }
  }
  return agent.model === undefined
    ? { kind: 'default', model: ENGINE_DEFAULT_MODEL, from: 'reading' }
    : { kind: 'named', model: agent.model.value, from: 'reading', quote: agent.model.quote }
}

/** Whether a node id is one of the ids a reading's `review-<round>` stands for. */
export function nodeMatches(pattern: string, id: string): boolean {
  const holes = pattern
    .split(/<[^>]*>|\$\{[^}]*\}|\*/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${holes.join('.+')}$`).test(id)
}

/**
 * The reading the page shows for a state, and only one by the reader in
 * force: a reading by any other is never put beside this one's.
 */
export function shownReading(
  state: ReadingState,
  reader: CatalogReaderSettings
): WorkflowReading | undefined {
  const reading = state.status === 'read' ? state.reading : state.last
  return reading !== undefined && sameReader(reading.reader, reader) ? reading : undefined
}

/** The entry a workflow name resolves to in a workspace: the winner, never what it shadows. */
export function entryOf(
  snapshot: CatalogSnapshot | undefined,
  workspacePath: string,
  name: string
): Exclude<CatalogEntry, { kind: 'shadowed' }> | undefined {
  const catalog = snapshot?.workspaces.find((candidate) => candidate.workspacePath === workspacePath)
  const found = catalog?.entries.find((entry) => entry.name === name && entry.kind !== 'shadowed')
  return found?.kind === 'shadowed' ? undefined : found
}

/** How a workflow's past runs in a workspace went, from the run records alone. */
export interface PastRuns {
  readonly count: number
  /** Newest first, at most five. */
  readonly recent: readonly RunRecord[]
  /** The median spend of the runs that have finished and reported one. */
  readonly typicalSpend?: number
}

export function pastRuns(runs: readonly RunRecord[], workspacePath: string, name: string): PastRuns {
  const mine = runs
    .filter((run) => run.workspacePath === workspacePath && run.workflow === name)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const spends = mine
    .filter((run) => !runIsLive(run))
    .map(runCost)
    .filter((cost): cost is number => cost !== undefined)
    .sort((left, right) => left - right)
  const typical = median(spends)
  return {
    count: mine.length,
    recent: mine.slice(0, 5),
    ...(typical === undefined ? {} : { typicalSpend: typical })
  }
}

function median(sorted: readonly number[]): number | undefined {
  if (sorted.length === 0) return undefined
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** The catalog as the Settings section states it, across every workspace it holds. */
export interface CatalogStatus {
  readonly read: number
  readonly reading: number
  readonly failed: number
  readonly broken: number
  /** ISO of the newest reading by the reader in force. */
  readonly lastReadAt?: string
}

export function catalogStatus(snapshot: CatalogSnapshot): CatalogStatus {
  // A user workflow appears in every workspace's catalog; it is one file and counts once.
  const byPath = new Map<string, CatalogEntry>()
  for (const catalog of snapshot.workspaces) {
    for (const entry of catalog.entries) byPath.set(entry.path, entry)
  }
  let read = 0
  let reading = 0
  let failed = 0
  let broken = 0
  let lastReadAt: string | undefined
  for (const entry of byPath.values()) {
    if (entry.kind === 'broken') broken += 1
    if (entry.kind !== 'workflow') continue
    const status = entry.reading.status
    if (status === 'read') read += 1
    else if (status === 'reading') reading += 1
    else failed += 1
    const shown = shownReading(entry.reading, snapshot.reader)
    if (shown !== undefined && (lastReadAt === undefined || shown.readAt > lastReadAt)) {
      lastReadAt = shown.readAt
    }
  }
  return { read, reading, failed, broken, ...(lastReadAt === undefined ? {} : { lastReadAt }) }
}

/** One model a workflow runs, and who runs it. */
export interface ModelUse {
  readonly fact: ModelFact
  /** Roles where a reading names them; node ids where only the plan does. */
  readonly by: readonly string[]
}

/** Every model a workflow runs, at a glance: grouped, in the order they first appear. */
export function modelUses(
  reading: WorkflowReading | undefined,
  plan: readonly PlannedModel[] | undefined
): readonly ModelUse[] {
  const uses = new Map<string, { fact: ModelFact; by: string[] }>()
  const add = (fact: ModelFact, who: string): void => {
    const key = `${fact.kind}\n${fact.model}`
    const found = uses.get(key)
    if (found === undefined) uses.set(key, { fact, by: [who] })
    else if (!found.by.includes(who)) found.by.push(who)
  }
  if (reading !== undefined) {
    for (const agent of reading.agents) add(modelFact(agent, plan), agent.role)
  } else {
    for (const node of plan ?? []) {
      add(
        node.model === undefined
          ? { kind: 'default', model: ENGINE_DEFAULT_MODEL, from: 'manifest' }
          : { kind: 'named', model: node.model, from: 'manifest' },
        node.id
      )
    }
  }
  return [...uses.values()]
}
