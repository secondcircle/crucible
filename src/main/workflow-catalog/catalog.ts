import type { Unsubscribe } from '../../shared/agent/port'
import type {
  CatalogEntry,
  CatalogListener,
  CatalogManifest,
  CatalogSnapshot,
  MainWorkflowCatalogService,
  PlannedModel,
  ReadingState,
  WorkflowReadAnswer,
  WorkflowReadRequest,
  WorkflowSourceFile
} from '../../shared/workflows/catalog'
import {
  readCatalogReaderSettings,
  readerKey,
  type CatalogReaderSettings
} from '../../shared/workflows/catalog-settings'
import { readingOf } from '../../shared/workflows/reader'
import type { WorkflowManifest } from '../workflows/host/host'
import type { LoadedWorkflow, SurveyedWorkflow, WorkflowSurveyor } from '../workflows/loader'
import { sourcesHash, workflowSources } from './sources'
import type { CatalogStore } from './store'

// The workflow catalog: every workflow a workspace on screen can run, each
// read by a model in the background and kept until its files or the reader
// change. Nothing here waits on a model before answering: a survey reads the
// folders and the manifests (each in a workflow host, never this process),
// says "reading" for whatever has no reading yet, and the readings land one
// by one as they finish. A reading that fails keeps the last good one beside
// its error and is tried again on the next change or the next launch, never
// on a timer, because every try is a paid call.

/** Watches a folder, subfolders too; absent means it cannot be watched now. */
export type WatchFolder = (folder: string, onChange: () => void) => (() => void) | undefined

export interface WorkflowCatalogOptions {
  readonly surveyor: WorkflowSurveyor
  /** The folders a workspace's workflows come from: its own and the user's. */
  readonly folders: (workspacePath: string) => readonly string[]
  /** One reading of one workflow, by the reader the request names: the agent seam. */
  readonly read: (request: WorkflowReadRequest) => Promise<WorkflowReadAnswer>
  readonly store: CatalogStore
  readonly watch: WatchFolder
  readonly sources?: (workflowPath: string) => Promise<readonly WorkflowSourceFile[]>
  /** What `plan()` forecasts for a workflow; absent when it has none or it will not answer. */
  readonly plan?: (workflow: LoadedWorkflow) => Promise<readonly PlannedModel[] | undefined>
  readonly now?: () => Date
  /** How long a save settles before the folder is surveyed again. */
  readonly debounceMs?: number
  /** How many readings are in flight at once. */
  readonly concurrency?: number
  readonly readTimeoutMs?: number
  readonly log?: (event: Record<string, unknown>) => void
}

/** A plan that has not answered in this long is not going to. */
const PLAN_MS = 15_000

/** One beat for a burst of changes, as the run seam does. */
const BROADCAST_MS = 100

interface OpenWorkspace {
  entries?: readonly CatalogEntry[]
  surveying?: Promise<void>
  again: boolean
  timer?: ReturnType<typeof setTimeout>
}

/** What the catalog wants read for one workflow file as it stands now. */
interface Wanted {
  readonly path: string
  readonly hash: string
  readonly key: string
  readonly request: WorkflowReadRequest
}

export function createWorkflowCatalog({
  surveyor,
  folders,
  read,
  store,
  watch,
  sources = (path) => workflowSources(path),
  plan = planOf,
  now = () => new Date(),
  debounceMs = 400,
  concurrency = 2,
  readTimeoutMs = 4 * 60_000,
  log
}: WorkflowCatalogOptions): MainWorkflowCatalogService {
  const listeners = new Set<CatalogListener>()
  // In the order they were opened, which is the snapshot's order.
  const opened = new Map<string, OpenWorkspace>()
  const watchers = new Map<string, () => void>()
  // By workflow file: one file can be in several workspaces' catalogs (a
  // user workflow is in all of them), and it is one reading.
  const wanted = new Map<string, Wanted>()
  // This launch's failures, by key: a key that failed is not asked again
  // until the files or the reader move it.
  const failures = new Map<string, string>()
  const queue: { readonly path: string; readonly key: string }[] = []
  const inFlight = new Set<string>()
  // Starting a host to ask `plan()` costs a process, so its answer is kept
  // for as long as the files it came from are the same.
  const plans = new Map<string, readonly PlannedModel[] | undefined>()
  let broadcastTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const keyOf = (reader: CatalogReaderSettings, hash: string): string => `${readerKey(reader)}\n${hash}`

  function stateOf(path: string, key: string): ReadingState {
    const kept = store.reading(path, readerKey(store.reader()))
    if (kept !== undefined && kept.key === key) return { status: 'read', reading: kept.reading }
    const last = kept === undefined ? {} : { last: kept.reading }
    const failure = failures.get(key)
    return failure === undefined
      ? { status: 'reading', ...last }
      : { status: 'failed', error: failure, ...last }
  }

  function snapshotNow(): CatalogSnapshot {
    return {
      reader: store.reader(),
      workspaces: [...opened.entries()].flatMap(([workspacePath, open]) =>
        open.entries === undefined ? [] : [{ workspacePath, entries: open.entries }]
      )
    }
  }

  function changed(): void {
    if (disposed || broadcastTimer !== undefined) return
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined
      const event = { type: 'catalog', snapshot: snapshotNow() } as const
      for (const listener of [...listeners]) listener(event)
    }, BROADCAST_MS)
  }

  async function entryOf(surveyed: SurveyedWorkflow): Promise<CatalogEntry> {
    if (surveyed.kind === 'shadowed') {
      return { kind: 'shadowed', name: surveyed.name, origin: 'user', path: surveyed.path, winner: surveyed.winner }
    }
    if (surveyed.kind === 'broken') {
      const { name, origin, path, error } = surveyed
      return { kind: 'broken', name, origin, path, error }
    }
    const { workflow } = surveyed
    let files: readonly WorkflowSourceFile[]
    try {
      files = await sources(workflow.path)
    } catch (cause) {
      return {
        kind: 'broken',
        name: workflow.name,
        origin: workflow.origin,
        path: workflow.path,
        error: `The file could not be read: ${messageOf(cause)}`
      }
    }
    const hash = sourcesHash(files)
    if (!plans.has(hash)) plans.set(hash, await plan(workflow))
    const planned = plans.get(hash)
    const manifest = manifestFacts(workflow.manifest)
    const reader = store.reader()
    const key = keyOf(reader, hash)
    wanted.set(workflow.path, {
      path: workflow.path,
      hash,
      key,
      request: {
        reader,
        name: workflow.name,
        files,
        manifest,
        ...(planned === undefined ? {} : { plan: planned })
      }
    })
    const reading = stateOf(workflow.path, key)
    return {
      kind: 'workflow',
      name: workflow.name,
      origin: workflow.origin,
      path: workflow.path,
      manifest,
      ...(planned === undefined ? {} : { plan: planned }),
      reading
    }
  }

  function refresh(workspacePath: string): Promise<void> {
    const open = opened.get(workspacePath)
    if (open === undefined) return Promise.resolve()
    if (open.surveying !== undefined) {
      open.again = true
      return open.surveying
    }
    open.surveying = (async () => {
      do {
        open.again = false
        try {
          const surveyed = await surveyor.survey(workspacePath)
          const entries = await Promise.all(surveyed.map(entryOf))
          // Stated again now it is all in hand: a reading may have landed
          // while the rest of the folder was being surveyed.
          open.entries = entries.map(current)
          for (const entry of open.entries) {
            if (entry.kind === 'workflow' && entry.reading.status === 'reading') {
              const want = wanted.get(entry.path)
              if (want !== undefined) enqueue(want.path, want.key)
            }
          }
        } catch (cause) {
          log?.({ event: 'catalog_survey_failed', workspacePath, message: messageOf(cause) })
          open.entries ??= []
        }
        watchFolders(workspacePath)
        changed()
      } while (open.again && !disposed)
    })().finally(() => {
      open.surveying = undefined
    })
    return open.surveying
  }

  function watchFolders(workspacePath: string): void {
    for (const folder of folders(workspacePath)) {
      if (watchers.has(folder)) continue
      const stop = watch(folder, () => folderChanged(folder))
      if (stop !== undefined) watchers.set(folder, stop)
    }
  }

  // The user's folder is every open workspace's, so a save there reaches them all.
  function folderChanged(folder: string): void {
    for (const workspacePath of opened.keys()) {
      if (folders(workspacePath).includes(folder)) settle(workspacePath)
    }
  }

  function settle(workspacePath: string): void {
    const open = opened.get(workspacePath)
    if (open === undefined || disposed) return
    if (open.timer !== undefined) clearTimeout(open.timer)
    open.timer = setTimeout(() => {
      open.timer = undefined
      void refresh(workspacePath)
    }, debounceMs)
  }

  function enqueue(path: string, key: string): void {
    if (inFlight.has(key) || queue.some((job) => job.key === key)) return
    queue.push({ path, key })
    pump()
  }

  function pump(): void {
    while (!disposed && inFlight.size < concurrency && queue.length > 0) {
      const job = queue.shift() as { readonly path: string; readonly key: string }
      const want = wanted.get(job.path)
      // Superseded while it waited: an edit or a new reader asked for another.
      if (want === undefined || want.key !== job.key) continue
      inFlight.add(job.key)
      void readOne(want).finally(() => {
        inFlight.delete(job.key)
        pump()
      })
    }
  }

  async function readOne(want: Wanted): Promise<void> {
    try {
      const answer = await within(read(want.request), readTimeoutMs, 'The reader did not answer in time.')
      const reading = readingOf(answer.reply, want.request, now().toISOString())
      store.keep(want.path, readerKey(want.request.reader), { key: want.key, reading })
      failures.delete(want.key)
      log?.({ event: 'catalog_read', path: want.path, reader: readerKey(want.request.reader) })
    } catch (cause) {
      failures.set(want.key, messageOf(cause))
      log?.({ event: 'catalog_read_failed', path: want.path, message: messageOf(cause) })
    }
    restate(want.path)
  }

  /** An entry with its reading state as it stands now. */
  function current(entry: CatalogEntry): CatalogEntry {
    if (entry.kind !== 'workflow') return entry
    const want = wanted.get(entry.path)
    return want === undefined ? entry : { ...entry, reading: stateOf(entry.path, want.key) }
  }

  /** Every open workspace's entry for a file, or for every file, stated again. */
  function restate(path?: string): void {
    for (const open of opened.values()) {
      open.entries = open.entries?.map((entry) =>
        path === undefined || entry.path === path ? current(entry) : entry
      )
    }
    changed()
  }

  return {
    async snapshot(): Promise<CatalogSnapshot> {
      await store.ready
      return snapshotNow()
    },

    async open(workspacePath: string): Promise<void> {
      await store.ready
      if (disposed) return
      if (!opened.has(workspacePath)) opened.set(workspacePath, { again: false })
      await refresh(workspacePath)
    },

    // Nothing is surveyed again: the files have not moved, only what a
    // reading of them is keyed by, so every wanted reading is re-keyed and
    // the ones the new reader has not made yet go back on the queue.
    async setReader(settings: CatalogReaderSettings): Promise<void> {
      await store.ready
      const reader = readCatalogReaderSettings(settings)
      store.setReader(reader)
      for (const [path, want] of wanted) {
        const key = keyOf(reader, want.hash)
        wanted.set(path, { ...want, key, request: { ...want.request, reader } })
      }
      restate()
      for (const want of wanted.values()) {
        if (stateOf(want.path, want.key).status === 'reading') enqueue(want.path, want.key)
      }
    },

    onEvent(listener: CatalogListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    dispose(): void {
      disposed = true
      if (broadcastTimer !== undefined) clearTimeout(broadcastTimer)
      for (const open of opened.values()) if (open.timer !== undefined) clearTimeout(open.timer)
      for (const stop of watchers.values()) stop()
      watchers.clear()
      queue.length = 0
      listeners.clear()
    }
  }
}

function manifestFacts(manifest: WorkflowManifest): CatalogManifest {
  return {
    description: manifest.description,
    inputs: { ...manifest.inputs },
    ...(manifest.commit === undefined ? {} : { commit: manifest.commit }),
    ...(manifest.target === undefined ? {} : { target: manifest.target }),
    ...(manifest.schedule === undefined ? {} : { schedule: manifest.schedule })
  }
}

// Asked with a placeholder for every input, since the catalog has none to
// give: a plan that reads its inputs' contents simply does not answer, and
// the page goes without its forecast.
async function planOf(workflow: LoadedWorkflow): Promise<readonly PlannedModel[] | undefined> {
  if (!workflow.manifest.plans) return undefined
  const host = workflow.open()
  try {
    const inputs = Object.fromEntries(
      Object.keys(workflow.manifest.inputs).map((name) => [name, `<${name}>`])
    )
    const planned: unknown = await within(host.plan(inputs), PLAN_MS, 'plan() did not answer.')
    if (!Array.isArray(planned)) return undefined
    return planned.flatMap((node: unknown): PlannedModel[] => {
      const { id, model } = (node ?? {}) as { id?: unknown; model?: unknown }
      if (typeof id !== 'string') return []
      return [typeof model === 'string' ? { id, model } : { id }]
    })
  } catch {
    return undefined
  } finally {
    host.kill()
  }
}

function within<T>(work: Promise<T>, ms: number, refusal: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(refusal)), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
