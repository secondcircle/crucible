// @vitest-environment jsdom
//
// The workflow catalog as a person meets it: the chip that opens the board,
// the list with each file's origin and state, a workflow's page with its
// agents, models and quoted prompts, the hover card on a workflow's name
// elsewhere in the window, and the Settings section that picks the reader.
// Driven through the catalog seam alone, so no reading happens here.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import type {
  CatalogEntry,
  CatalogSnapshot,
  SourceQuote,
  WorkflowReading
} from '../../shared/workflows/catalog'
import { DEFAULT_CATALOG_READER } from '../../shared/workflows/catalog-settings'
import type { RunRecord } from '../../shared/workflows/run'
import { quotedLines } from '../../shared/workflows/source-scan'
import { Shell } from './Shell'
import { createScriptedCatalog, type ScriptedCatalog } from './testing/scripted-catalog'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkflowRuns } from './testing/scripted-workflow-runs'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { settled } from './testing/settled'

const HERE = '/repos/crucible'
const FOLDER = `${HERE}/.crucible/workflows`
const USER = '/home/me/.crucible/workflows'

const SNAPSHOT: ShellSnapshot = {
  workspaces: [{ id: 'w1', name: 'crucible', path: HERE }],
  activeWorkspaceId: 'w1',
  activeSessionId: 's1',
  sessions: [
    {
      id: 's1',
      workspaceId: 'w1',
      createdAt: '2026-08-24T10:00:00.000Z',
      title: 'catalog',
      working: false,
      fresh: false
    }
  ]
}

const BUILD = [
  "import { workflow } from 'crucible:workflow'", // 1
  "const CODE_MODEL = 'anthropic/claude-opus-5-5:high'", // 2
  "const REVIEW_MODEL = 'anthropic/claude-fable-5:xhigh'", // 3
  'const NODE_SYSTEM = `You are one node of a run.`', // 4
  'function builderPrompt(intent: string): string {', // 5
  '  return `Implement ${intent} completely.`', // 6
  '}' // 7
].join('\n')

function quote(start: number, end: number): SourceQuote {
  return {
    file: `${FOLDER}/build.ts`,
    start,
    end,
    lines: quotedLines(BUILD, start, end)
  }
}

function reading(overrides: Partial<WorkflowReading> = {}): WorkflowReading {
  return {
    reader: DEFAULT_CATALOG_READER,
    readAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    summary: 'Takes an intent document to built, reviewed code on a branch.',
    agents: [
      {
        role: 'Builder',
        nodes: ['builder'],
        does: 'Implements the intent document.',
        model: { value: 'anthropic/claude-opus-5-5:high', quote: quote(2, 2) },
        system: { name: 'NODE_SYSTEM', ...quote(4, 4) },
        prompt: { name: 'builderPrompt', ...quote(5, 7) }
      },
      {
        role: 'Reviewer',
        nodes: ['review-<round>'],
        does: 'Judges the branch.',
        model: { value: 'anthropic/claude-fable-5:xhigh', quote: quote(3, 3) }
      }
    ],
    steps: ['The builder builds.', 'A reviewer reviews until it approves.'],
    stops: ['After three rejections in a row it asks whether the loop is on task.'],
    returns: {
      artifacts: [{ file: 'review-<round>.md', what: 'each review' }],
      branch: 'the built work',
      report: 'the final verdict'
    },
    ...overrides
  }
}

const ENTRIES: readonly CatalogEntry[] = [
  {
    kind: 'workflow',
    name: 'adhoc',
    origin: 'workspace',
    path: `${FOLDER}/adhoc.ts`,
    manifest: {
      description: 'one agent on a prompt file',
      inputs: { prompt: 'a file' }
    },
    reading: { status: 'reading' }
  },
  {
    kind: 'workflow',
    name: 'audit',
    origin: 'workspace',
    path: `${FOLDER}/audit.ts`,
    manifest: {
      description: 'audits the main thread',
      inputs: {},
      commit: false
    },
    reading: {
      status: 'read',
      reading: reading({
        summary: 'Audits the main thread for blocking work.',
        agents: [{ role: 'Auditor', nodes: ['audit'], does: 'Audits.' }],
        stops: []
      })
    }
  },
  {
    kind: 'workflow',
    name: 'build',
    origin: 'workspace',
    path: `${FOLDER}/build.ts`,
    manifest: {
      description: 'intent to branch',
      inputs: { intent: 'the intent document' }
    },
    reading: { status: 'read', reading: reading() }
  },
  {
    kind: 'shadowed',
    name: 'build',
    origin: 'user',
    path: `${USER}/build.ts`,
    winner: `${FOLDER}/build.ts`
  },
  {
    kind: 'workflow',
    name: 'notes',
    origin: 'user',
    path: `${USER}/notes.ts`,
    manifest: { description: 'keeps notes', inputs: {} },
    reading: {
      status: 'failed',
      error: 'The reading cites notes.ts:90 for Writer’s model, but notes.ts has 12 lines.',
      last: reading({ summary: 'Keeps notes, the last good reading.' })
    }
  },
  {
    kind: 'broken',
    name: 'wip',
    origin: 'user',
    path: `${USER}/wip.ts`,
    error: 'Unexpected token (3:4)'
  }
]

function catalogOf(entries: readonly CatalogEntry[] = ENTRIES): CatalogSnapshot {
  return {
    reader: DEFAULT_CATALOG_READER,
    workspaces: [{ workspacePath: HERE, entries }]
  }
}

function mount(
  snapshot: CatalogSnapshot = catalogOf(),
  runs: readonly RunRecord[] = []
): { readonly port: ScriptedPort; readonly catalog: ScriptedCatalog } {
  const port = createScriptedPort(SNAPSHOT)
  port.models = [
    {
      id: 'anthropic/claude-sonnet-5-5',
      label: 'Sonnet 5.5',
      thinkingLevels: ['low', 'medium', 'high']
    },
    {
      id: 'anthropic/claude-haiku-5',
      label: 'Haiku 5',
      thinkingLevels: ['off', 'low']
    }
  ]
  const catalog = createScriptedCatalog(snapshot)
  render(
    <Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
      workflowRuns={createScriptedWorkflowRuns(runs)}
      catalog={catalog}
    />
  )
  return { port, catalog }
}

const chip = (): HTMLElement | null => screen.queryByRole('button', { name: 'Workflow catalog' })
const board = (): HTMLElement => screen.getByRole('dialog', { name: 'Workflow catalog' })
const page = (name: string): HTMLElement =>
  within(board()).getByRole('article', { name: `Workflow ${name}` })

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element)
    await settled()
  })
}

async function openBoard(
  snapshot?: CatalogSnapshot,
  runs?: readonly RunRecord[]
): Promise<ReturnType<typeof mount>> {
  const held = mount(snapshot, runs)
  await act(settled)
  await click(chip() as HTMLElement)
  return held
}

async function choose(label: string): Promise<void> {
  await click(within(board()).getByRole('button', { name: label }))
}

function runOf(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: 'e7a2',
    workflow: 'build',
    status: 'complete',
    workspacePath: HERE,
    workspaceName: 'crucible',
    worktreePath: `${HERE}/.crucible/worktrees/run-e7a2`,
    branch: 'crucible/run-e7a2',
    baseCommit: '41c9f02abcdef',
    inputs: {},
    nodes: [
      {
        id: 'builder',
        status: 'complete',
        parents: [],
        reads: [],
        artifacts: [],
        cost: 2
      }
    ],
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    endedAt: new Date(Date.now() - 3_000_000).toISOString(),
    ...overrides
  }
}

describe('the workflow catalog chip', () => {
  it('is absent until the catalog has answered for this workspace', async () => {
    const { catalog } = mount({
      reader: DEFAULT_CATALOG_READER,
      workspaces: []
    })
    await act(settled)
    expect(chip()).toBeNull()
    // The workspace on screen is opened in the catalog, which watches it from then on.
    expect(catalog.calls).toContainEqual({ op: 'open', workspacePath: HERE })

    await act(async () => {
      catalog.setSnapshot(catalogOf())
      await settled()
    })
    // What can run here: a shadowed file is not one of them.
    expect(chip()).toHaveTextContent('5 workflows')
  })
})

describe('the workflow catalog board', () => {
  it('lists both origins with each file’s state', async () => {
    await openBoard()
    const rows = (group: string): string[] =>
      within(within(board()).getByLabelText(group))
        .getAllByRole('button')
        .map((row) => row.textContent ?? '')

    expect(rows('This workspace')).toEqual([
      'adhocone agent on a prompt filereading',
      'auditaudits the main thread',
      'buildintent to branch'
    ])
    expect(rows('Yours, from ~/.crucible')).toEqual([
      'buildbuild.ts in this workspace winsshadowed',
      'noteskeeps notesfailed',
      'wipdoes not loadbroken'
    ])
  })

  it('shows a workflow’s page top to bottom, each fact saying where it came from', async () => {
    await openBoard(catalogOf(), [runOf({}), runOf({ id: 'f1x9', status: 'failed' })])
    await choose('Workflow build')
    const shown = page('build')

    const section = (title: string): HTMLElement =>
      within(shown).getByRole('region', { name: title })
    expect(section('What it does')).toHaveTextContent(
      'Takes an intent document to built, reviewed code'
    )
    expect(section('What it does')).toHaveTextContent('read by claude-sonnet-5-5 · medium')
    expect(section('What you give it')).toHaveTextContent('intentthe intent document')
    expect(section('What you give it')).toHaveTextContent('from the manifest')
    expect(section('Where it works')).toHaveTextContent('commits whatever the worktree holds')
    expect(section('How a run goes').querySelectorAll('li')).toHaveLength(2)
    expect(section('When it stops to ask you')).toHaveTextContent('After three rejections')
    expect(section('What you get back')).toHaveTextContent('review-<round>.md')
    expect(section('What you get back')).toHaveTextContent('the built work')
    expect(section('Past runs')).toHaveTextContent('2 runs in this workspace')
    expect(section('Past runs')).toHaveTextContent('from run records')
    // Roles, never a graph.
    expect(shown.querySelector('svg')).toBeNull()
  })

  it('names each agent’s model, and the engine default as the default', async () => {
    await openBoard()
    await choose('Workflow build')
    expect(within(page('build')).getByRole('button', { name: 'Agent Builder' })).toHaveTextContent(
      'Opus · highnamed in the file'
    )
    expect(within(page('build')).getByRole('button', { name: 'Agent Reviewer' })).toHaveTextContent(
      'Fable · xhighnamed in the file'
    )

    await choose('Workflow audit')
    expect(within(page('audit')).getByRole('button', { name: 'Agent Auditor' })).toHaveTextContent(
      'Opus · highengine default'
    )
  })

  it('opens an agent onto its prompts, quoted from source with what a run fills in marked', async () => {
    await openBoard()
    await choose('Workflow build')
    await click(within(page('build')).getByRole('button', { name: 'Agent Builder' }))

    const task = within(page('build')).getByLabelText('Task prompt')
    expect(task).toHaveTextContent('builderPrompt')
    expect(within(task).getByRole('button', { name: 'build.ts:5–7' })).toBeEnabled()
    const lines = [...task.querySelectorAll('.ql')].map((line) => line.textContent)
    expect(lines).toEqual([
      '5function builderPrompt(intent: string): string {',
      '6  return `Implement ${intent} completely.`',
      '7}'
    ])
    expect([...task.querySelectorAll('.quote mark')].map((mark) => mark.textContent)).toEqual([
      '${intent}'
    ])
    expect(within(page('build')).getByLabelText('System prompt')).toHaveTextContent(
      'You are one node of a run.'
    )
  })

  it('says reading until a reading lands, and shows a failure beside the last good one', async () => {
    await openBoard()
    await choose('Workflow adhoc')
    expect(within(page('adhoc')).getByRole('status')).toHaveTextContent('reading the file')
    expect(page('adhoc')).toHaveTextContent('one agent on a prompt file')

    await choose('Workflow notes')
    expect(within(page('notes')).getByRole('alert')).toHaveTextContent('notes.ts has 12 lines')
    expect(page('notes')).toHaveTextContent('Keeps notes, the last good reading.')
  })

  it('shows a shadowed file naming the one that wins, and a broken file with its error', async () => {
    await openBoard()
    await choose('Workflow build (shadowed)')
    expect(page('build')).toHaveTextContent(
      `Shadowed. ${FOLDER}/build.ts has the same name and wins`
    )

    await choose('Workflow wip')
    expect(within(page('wip')).getByRole('alert')).toHaveTextContent('Unexpected token (3:4)')
  })

  it('follows the catalog as it changes, with no click', async () => {
    const { catalog } = await openBoard()
    await choose('Workflow adhoc')
    await act(async () => {
      catalog.setSnapshot(
        catalogOf(
          ENTRIES.map((entry) =>
            entry.name === 'adhoc' && entry.kind === 'workflow'
              ? {
                  ...entry,
                  reading: {
                    status: 'read',
                    reading: reading({
                      summary: 'Runs one agent, freshly read.'
                    })
                  }
                }
              : entry
          )
        )
      )
      await settled()
    })
    expect(page('adhoc')).toHaveTextContent('Runs one agent, freshly read.')
  })

  it('closes on Escape', async () => {
    await openBoard()
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
      await settled()
    })
    expect(screen.queryByRole('dialog', { name: 'Workflow catalog' })).toBeNull()
  })
})

describe('a workflow’s name elsewhere in the window', () => {
  it('opens a card with the summary, inputs and models, and a way into the page', async () => {
    mount(catalogOf(), [runOf({ status: 'running', sessionId: 's1', endedAt: undefined })])
    await act(settled)
    const name = document.querySelector('.wfname') as HTMLElement
    expect(name).toHaveTextContent('build')

    await act(async () => {
      fireEvent.mouseEnter(name)
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    const card = screen.getByRole('dialog', { name: 'Workflow build' })
    expect(card).toHaveTextContent('Takes an intent document to built, reviewed code')
    expect(card).toHaveTextContent('intent — the intent document')
    expect(card).toHaveTextContent('Opus · high')
    expect(card).toHaveTextContent('Fable · xhigh')

    await click(
      within(card).getByRole('button', {
        name: 'Open its page in the catalog →'
      })
    )
    expect(within(board()).getByRole('button', { name: 'Workflow build' })).toHaveAttribute(
      'aria-current',
      'true'
    )
    expect(page('build')).toBeInTheDocument()
  })
})

describe('the Workflow catalog section of Settings', () => {
  async function openSection(): Promise<ScriptedCatalog> {
    const { catalog } = mount()
    await act(settled)
    await click(screen.getByRole('button', { name: 'Settings' }))
    await click(
      within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', {
        name: /Workflow catalog/
      })
    )
    return catalog
  }

  it('shows the reader and the state of the catalog', async () => {
    await openSection()
    expect(screen.getByRole('combobox', { name: 'Reader model' })).toHaveValue(
      'anthropic/claude-sonnet-5-5'
    )
    expect(screen.getByRole('combobox', { name: 'Reader effort' })).toHaveValue('medium')
    const cards = screen.getByLabelText('Catalog state')
    expect(cards).toHaveTextContent('Read2')
    expect(cards).toHaveTextContent('Reading1')
    expect(cards).toHaveTextContent('Failed2')
    expect(screen.getByRole('table', { name: 'Catalog failures' })).toHaveTextContent(
      'wipdoes not load'
    )
  })

  it('changes the reader, which rereads in the background', async () => {
    const catalog = await openSection()
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox', { name: 'Reader model' }), {
        target: { value: 'anthropic/claude-haiku-5' }
      })
      await settled()
    })
    // Medium is not a level Haiku offers, so the effort moves with the model.
    expect(catalog.calls).toContainEqual({
      op: 'setReader',
      settings: { model: 'anthropic/claude-haiku-5', effort: 'low' }
    })
    expect(screen.getByRole('combobox', { name: 'Reader model' })).toHaveValue(
      'anthropic/claude-haiku-5'
    )
  })
})
