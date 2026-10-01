// @vitest-environment node
// Review reproduction (review-1.md, finding 1): two open workspaces holding
// the same workflow file — same name, same bytes, as two worktrees of one
// repository do — share one read key, and the second workspace's entry is
// stranded in "reading" forever when both are opened while the first read is
// still in flight. This test is expected to FAIL on the branch under review.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cannedReply } from '../../shared/workflows/canned-readings'
import type {
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

describe('two workspaces holding the same workflow file', () => {
  it('both end read, even when they are opened while the first read is in flight', async () => {
    // Two worktrees of one repository: the same file name, the same bytes.
    const files = new Map([
      ['/a/.crucible/workflows/tidy.ts', TEXT],
      ['/b/.crucible/workflows/tidy.ts', TEXT]
    ])
    const read = async (path: string): Promise<string> => {
      const text = files.get(path)
      if (text === undefined) throw new Error(`ENOENT ${path}`)
      return text
    }
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const snapshots: CatalogSnapshot[] = []
    const catalog = createWorkflowCatalog({
      surveyor: {
        survey: async (workspacePath) => [loaded(`${workspacePath}/.crucible/workflows/tidy.ts`)]
      },
      folders: (workspacePath) => [`${workspacePath}/.crucible/workflows`],
      read: async (request: WorkflowReadRequest): Promise<WorkflowReadAnswer> => {
        await held
        return { reply: cannedReply(request) }
      },
      store: memoryCatalogStore(),
      watch: () => () => {},
      sources: (path) => workflowSources(path, read),
      debounceMs: 0,
      now: () => new Date('2026-09-01T00:00:00.000Z')
    })
    catalog.onEvent((event) => snapshots.push(event.snapshot))
    live.push(catalog)

    // Both workspaces come on screen while the one read is still in flight.
    await catalog.open('/a')
    await catalog.open('/b')
    release()

    await vi.waitFor(() => {
      const latest = snapshots.at(-1)
      for (const workspacePath of ['/a', '/b']) {
        const entries = latest?.workspaces.find((w) => w.workspacePath === workspacePath)?.entries
        expect(entries?.[0], `the entry of ${workspacePath}`).toMatchObject({
          kind: 'workflow',
          reading: { status: 'read' }
        })
      }
    })
  })
})
