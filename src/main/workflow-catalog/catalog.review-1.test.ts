// @vitest-environment node
// Review reproduction (review-1.md, finding 1): two open workspaces holding
// the same workflow file — same name, same bytes, as two worktrees of one
// repository do — share one read key, and the second workspace's entry is
// stranded in "reading" forever when both are opened while the first read is
// still in flight. Readings are now kept by reader and source-set hash, the
// key the queue dedupes on, so one reading answers both, paid for once, and
// each workspace's page quotes its own file.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cannedReply } from '../../shared/workflows/canned-readings'
import type {
  CatalogEntry,
  CatalogSnapshot,
  MainWorkflowCatalogService,
  WorkflowReadAnswer,
  WorkflowReadRequest
} from '../../shared/workflows/catalog'
import type { WorkflowManifest } from '../workflows/host/host'
import type { LoadedWorkflow, SurveyedWorkflow } from '../workflows/loader'
import { createWorkflowCatalog } from './catalog'
import { workflowSources } from './sources'
import { memoryCatalogStore } from './store'

const TEXT = [
  "import { workflow } from 'crucible:workflow'",
  "const MODEL = 'anthropic/claude-opus-5-5:high'",
  'const taskPrompt = (intent: string): string => `Build ${intent}`',
  'export default workflow({',
  '  run: async (ctx) => {',
  "    await ctx.node('work', { model: MODEL, prompt: taskPrompt })",
  '  }',
  '})'
].join('\n')

const MANIFEST: WorkflowManifest = {
  description: 'does the work',
  inputs: {},
  plans: false
}

function loaded(path: string): SurveyedWorkflow {
  const workflow: LoadedWorkflow = {
    name: 'tidy',
    origin: 'workspace',
    path,
    manifest: MANIFEST,
    open: () => {
      throw new Error('no host in this test')
    }
  }
  return { kind: 'loaded', workflow }
}

const live: MainWorkflowCatalogService[] = []

afterEach(() => {
  for (const catalog of live.splice(0)) catalog.dispose()
})

function harness(): {
  catalog: MainWorkflowCatalogService
  snapshots: CatalogSnapshot[]
  reads: WorkflowReadRequest[]
  release: () => void
  entry: (workspacePath: string) => CatalogEntry | undefined
} {
  // Two worktrees of one repository: the same file name, the same bytes.
  const files = new Map([
    ['/a/.crucible/workflows/tidy.ts', TEXT],
    ['/b/.crucible/workflows/tidy.ts', TEXT]
  ])
  const readText = async (path: string): Promise<string> => {
    const text = files.get(path)
    if (text === undefined) throw new Error(`ENOENT ${path}`)
    return text
  }
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  const snapshots: CatalogSnapshot[] = []
  const reads: WorkflowReadRequest[] = []
  const catalog = createWorkflowCatalog({
    surveyor: {
      survey: async (workspacePath) => [loaded(`${workspacePath}/.crucible/workflows/tidy.ts`)]
    },
    folders: (workspacePath) => [`${workspacePath}/.crucible/workflows`],
    read: async (request: WorkflowReadRequest): Promise<WorkflowReadAnswer> => {
      reads.push(request)
      await held
      return { reply: cannedReply(request) }
    },
    store: memoryCatalogStore(),
    watch: () => () => {},
    sources: (path) => workflowSources(path, readText),
    debounceMs: 0,
    now: () => new Date('2026-09-01T00:00:00.000Z')
  })
  catalog.onEvent((event) => snapshots.push(event.snapshot))
  live.push(catalog)
  return {
    catalog,
    snapshots,
    reads,
    release: () => release(),
    entry: (workspacePath) =>
      snapshots.at(-1)?.workspaces.find((w) => w.workspacePath === workspacePath)?.entries[0]
  }
}

/** Both read, once between them, each quoting the file in its own workspace. */
async function bothRead(h: ReturnType<typeof harness>): Promise<void> {
  await vi.waitFor(() => {
    for (const workspacePath of ['/a', '/b']) {
      expect(h.entry(workspacePath), `the entry of ${workspacePath}`).toMatchObject({
        kind: 'workflow',
        reading: { status: 'read' }
      })
    }
  })
  expect(h.reads).toHaveLength(1)
  for (const workspacePath of ['/a', '/b']) {
    const entry = h.entry(workspacePath)
    const reading = entry?.kind === 'workflow' && entry.reading.status === 'read' ? entry.reading.reading : undefined
    const quotes = reading?.agents.flatMap((agent) => [agent.model?.quote, agent.prompt].filter((q) => q !== undefined))
    expect(quotes?.length, `the quotes of ${workspacePath}`).toBeGreaterThan(0)
    for (const quote of quotes ?? []) expect(quote.file).toBe(`${workspacePath}/.crucible/workflows/tidy.ts`)
  }
}

describe('two workspaces holding the same workflow file', () => {
  it('both end read, even when they are opened while the first read is in flight', async () => {
    const h = harness()
    // Both workspaces come on screen while the one read is still in flight.
    await h.catalog.open('/a')
    await h.catalog.open('/b')
    h.release()
    await bothRead(h)
  })

  it('are read once, when the second is opened after the first one’s reading landed', async () => {
    const h = harness()
    h.release()
    await h.catalog.open('/a')
    await vi.waitFor(() => expect(h.entry('/a')).toMatchObject({ reading: { status: 'read' } }))
    await h.catalog.open('/b')
    await bothRead(h)
  })
})
