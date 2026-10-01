// @vitest-environment node
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
import { memoryCatalogStore } from './store'

// The catalog over fakes at every edge: the folders are a list, the files a
// map, the watcher a callback held here, and the reader the fake flavor's
// canned one, whose replies pass through the same check a model's do.

const WORKSPACE = '/repo'
const FOLDER = '/repo/.crucible/workflows'
const USER = '/home/.crucible/workflows'

const HELPER = 'export const NODE_SYSTEM = `You are a node.`\n'

function workflowText(prompt: string): string {
  return [
    "import { workflow } from 'crucible:workflow'",
    "import { NODE_SYSTEM } from './lib/system'",
    "const MODEL = 'anthropic/claude-opus-5-5:high'",
    `const taskPrompt = (intent: string): string => \`${prompt} \${intent}\``,
    'export default workflow({',
    '  run: async (ctx) => {',
    "    await ctx.node('work', { model: MODEL, system: NODE_SYSTEM, prompt: taskPrompt })",
    '  }',
    '})'
  ].join('\n')
}

const MANIFEST: WorkflowManifest = {
  description: 'does the work',
  inputs: { intent: 'what to do' },
  plans: false
}

function loaded(
  name: string,
  path: string,
  origin: 'user' | 'workspace' = 'workspace'
): SurveyedWorkflow {
  const workflow: LoadedWorkflow = {
    name,
    origin,
    path,
    manifest: MANIFEST,
    open: () => {
      throw new Error('no host in this test')
    }
  }
  return { kind: 'loaded', workflow }
}

interface Harness {
  readonly catalog: MainWorkflowCatalogService
  readonly files: Map<string, string>
  readonly reads: WorkflowReadRequest[]
  readonly snapshots: CatalogSnapshot[]
  survey: SurveyedWorkflow[]
  answer: (request: WorkflowReadRequest) => Promise<WorkflowReadAnswer>
  /** Saves in a watched folder. */
  save(folder: string): void
  entries(): readonly CatalogEntry[]
}

const live: MainWorkflowCatalogService[] = []

afterEach(() => {
  for (const catalog of live.splice(0)) catalog.dispose()
})

function harness(): Harness {
  const watched = new Map<string, () => void>()
  const store = memoryCatalogStore()
  const h: Harness = {
    files: new Map([
      [`${FOLDER}/tidy.ts`, workflowText('Build')],
      [`${FOLDER}/lib/system.ts`, HELPER]
    ]),
    reads: [],
    snapshots: [],
    survey: [loaded('tidy', `${FOLDER}/tidy.ts`)],
    answer: async (request) => ({ reply: cannedReply(request) }),
    save: (folder) => watched.get(folder)?.(),
    entries: () => h.snapshots.at(-1)?.workspaces[0]?.entries ?? [],
    catalog: undefined as unknown as MainWorkflowCatalogService
  }
  const read = async (path: string): Promise<string> => {
    const text = h.files.get(path)
    if (text === undefined) throw new Error(`ENOENT ${path}`)
    return text
  }
  const catalog = createWorkflowCatalog({
    surveyor: { survey: async () => h.survey },
    folders: () => [FOLDER, USER],
    read: (request) => {
      h.reads.push(request)
      return h.answer(request)
    },
    store,
    watch: (folder, onChange) => {
      watched.set(folder, onChange)
      return () => watched.delete(folder)
    },
    sources: async (path) => {
      const { workflowSources } = await import('./sources')
      return workflowSources(path, read)
    },
    debounceMs: 0,
    now: () => new Date('2026-09-01T00:00:00.000Z')
  })
  catalog.onEvent((event) => h.snapshots.push(event.snapshot))
  live.push(catalog)
  return Object.assign(h, { catalog })
}

function only(h: Harness): Extract<CatalogEntry, { kind: 'workflow' }> {
  const entry = h.entries().find((candidate) => candidate.kind === 'workflow')
  if (entry?.kind !== 'workflow') throw new Error('no workflow entry')
  return entry
}

describe('the workflow catalog', () => {
  it('says reading at once, then shows the reading when it lands', async () => {
    const h = harness()
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    h.answer = async (request) => {
      await held
      return { reply: cannedReply(request) }
    }
    await h.catalog.open(WORKSPACE)
    expect((await h.catalog.snapshot()).workspaces[0].entries[0]).toMatchObject({
      kind: 'workflow',
      manifest: {
        description: 'does the work',
        inputs: { intent: 'what to do' }
      },
      reading: { status: 'reading' }
    })

    release()
    await vi.waitFor(() => expect(only(h).reading).toMatchObject({ status: 'read' }))
    // The reader saw the workflow and the helper it imports, labelled as cited.
    expect(h.reads[0].files.map((file) => file.label)).toEqual(['tidy.ts', 'lib/system.ts'])
  })

  it('reads nothing again while the files and the reader stand still', async () => {
    const h = harness()
    await h.catalog.open(WORKSPACE)
    await vi.waitFor(() => expect(only(h).reading).toMatchObject({ status: 'read' }))
    await h.catalog.open(WORKSPACE)
    h.save(FOLDER)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(h.reads).toHaveLength(1)
  })

  it('rereads on a save to an imported file, with no click', async () => {
    const h = harness()
    await h.catalog.open(WORKSPACE)
    await vi.waitFor(() => expect(only(h).reading).toMatchObject({ status: 'read' }))

    h.files.set(`${FOLDER}/lib/system.ts`, 'export const NODE_SYSTEM = `You are a better node.`\n')
    h.save(FOLDER)
    await vi.waitFor(() => expect(h.reads).toHaveLength(2))
    expect(h.reads[1].files[1].text).toContain('better node')
    await vi.waitFor(() => expect(only(h).reading).toMatchObject({ status: 'read' }))
  })

  it('keeps the last good reading beside a failure, and tries again only on a change', async () => {
    const h = harness()
    await h.catalog.open(WORKSPACE)
    await vi.waitFor(() => expect(only(h).reading).toMatchObject({ status: 'read' }))

    // A citation the file does not bear out fails the reading whole.
    h.answer = async () => ({
      reply: JSON.stringify({
        summary: 'x',
        agents: [
          {
            role: 'W',
            nodes: ['work'],
            does: 'w',
            model: null,
            system: null,
            prompt: { name: 'taskPrompt', file: 'tidy.ts', start: 90, end: 99 }
          }
        ],
        steps: ['s'],
        stops: [],
        returns: { artifacts: [], branch: null, report: 'r' }
      })
    })
    h.files.set(`${FOLDER}/tidy.ts`, workflowText('Build again'))
    h.save(FOLDER)
    await vi.waitFor(() => expect(only(h).reading.status).toBe('failed'))
    const failed = only(h).reading
    expect(failed).toMatchObject({
      error: expect.stringMatching(/tidy\.ts has 9 lines/)
    })
    expect(failed.status === 'failed' && failed.last?.summary).toBeTruthy()

    await h.catalog.open(WORKSPACE)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(h.reads).toHaveLength(2)

    h.answer = async (request) => ({ reply: cannedReply(request) })
    h.files.set(`${FOLDER}/tidy.ts`, workflowText('Build a third time'))
    h.save(FOLDER)
    await vi.waitFor(() => expect(only(h).reading).toMatchObject({ status: 'read' }))
  })

  it('rereads everything under a new reader and never shows the old one’s work', async () => {
    const h = harness()
    await h.catalog.open(WORKSPACE)
    await vi.waitFor(() => expect(only(h).reading).toMatchObject({ status: 'read' }))

    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    h.answer = async (request) => {
      await held
      return { reply: cannedReply(request) }
    }
    const haiku = { model: 'anthropic/claude-haiku-5', effort: 'low' }
    await h.catalog.setReader(haiku)
    await vi.waitFor(() => expect(h.snapshots.at(-1)?.reader).toEqual(haiku))
    // Under way, and the Sonnet reading is not offered as the last good one.
    expect(only(h).reading).toEqual({ status: 'reading' })
    expect(h.reads.at(-1)?.reader).toEqual(haiku)

    release()
    await vi.waitFor(() => {
      const reading = only(h).reading
      expect(reading.status === 'read' && reading.reading.reader).toEqual(haiku)
    })
  })

  it('lists a shadowed user workflow and a broken file as such, and reads neither', async () => {
    const h = harness()
    h.survey = [
      loaded('tidy', `${FOLDER}/tidy.ts`),
      {
        kind: 'shadowed',
        name: 'tidy',
        path: `${USER}/tidy.ts`,
        winner: `${FOLDER}/tidy.ts`
      },
      {
        kind: 'broken',
        name: 'wip',
        origin: 'user',
        path: `${USER}/wip.ts`,
        error: 'Unexpected token'
      }
    ]
    await h.catalog.open(WORKSPACE)
    const entries = (await h.catalog.snapshot()).workspaces[0].entries
    expect(entries.slice(1)).toEqual([
      {
        kind: 'shadowed',
        name: 'tidy',
        origin: 'user',
        path: `${USER}/tidy.ts`,
        winner: `${FOLDER}/tidy.ts`
      },
      {
        kind: 'broken',
        name: 'wip',
        origin: 'user',
        path: `${USER}/wip.ts`,
        error: 'Unexpected token'
      }
    ])
    await vi.waitFor(() => expect(only(h).reading).toMatchObject({ status: 'read' }))
    expect(h.reads.map((request) => request.name)).toEqual(['tidy'])
  })

  it('reaches every open workspace from a save in the user’s folder', async () => {
    const h = harness()
    h.files.set(`${USER}/notes.ts`, workflowText('Notes'))
    h.survey = [loaded('notes', `${USER}/notes.ts`, 'user')]
    await h.catalog.open(WORKSPACE)
    await h.catalog.open('/other')
    await vi.waitFor(() => expect(h.reads).toHaveLength(1))

    h.files.set(`${USER}/notes.ts`, workflowText('Notes, edited'))
    h.save(USER)
    // One file, one reading, though two workspaces list it.
    await vi.waitFor(() => expect(h.reads).toHaveLength(2))
    await vi.waitFor(() => {
      const workspaces = h.snapshots.at(-1)?.workspaces ?? []
      expect(workspaces.map((one) => one.workspacePath)).toEqual([WORKSPACE, '/other'])
      for (const one of workspaces)
        expect(one.entries[0]).toMatchObject({ reading: { status: 'read' } })
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(h.reads).toHaveLength(2)
  })
})
