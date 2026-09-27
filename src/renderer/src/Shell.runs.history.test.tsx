// @vitest-environment jsdom
//
// ⌘R over a long history: Done opens on its newest page and grows at the foot,
// and the filter in the header reaches every run ever recorded. Driven through
// the run seam, like every other test of the view.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import type { RunRecord } from '../../shared/workflows/run'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort } from './testing/scripted-port'
import { createScriptedWorkflowRuns } from './testing/scripted-workflow-runs'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { settled } from './testing/settled'

const SNAPSHOT: ShellSnapshot = {
  workspaces: [
    { id: 'w1', name: 'crucible', path: '/repos/crucible' },
    { id: 'w2', name: 'resume-site', path: '/repos/resume-site' }
  ],
  activeWorkspaceId: 'w1',
  activeSessionId: 's1',
  sessions: [
    {
      id: 's1',
      workspaceId: 'w1',
      createdAt: '2026-08-20T10:00:00.000Z',
      title: 'panel handoff build',
      working: false,
      fresh: false
    },
    {
      id: 's2',
      workspaceId: 'w1',
      createdAt: '2026-08-20T10:01:00.000Z',
      title: 'ledger rounding fix',
      working: false,
      fresh: false
    }
  ]
}

const HOUR = 3_600_000

function ago(hours: number): string {
  return new Date(Date.now() - hours * HOUR).toISOString()
}

function runOf(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: 'en42',
    workflow: 'build',
    status: 'running',
    workspacePath: '/repos/crucible',
    workspaceName: 'crucible',
    sessionId: 's1',
    worktreePath: '/repos/crucible/.crucible/worktrees/run-en42',
    branch: 'crucible/run-en42',
    baseCommit: '6c90bb0abcdef',
    inputs: {},
    nodes: [],
    createdAt: ago(1),
    startedAt: ago(1),
    ...overrides
  }
}

/** `count` finished runs, newest first by id: d000 ended an hour ago. */
function history(count: number, overrides: Partial<RunRecord> = {}): RunRecord[] {
  return Array.from({ length: count }, (_, at) => {
    const id = `d${String(at).padStart(3, '0')}`
    return runOf({
      id,
      workflow: 'backlog-triage',
      status: 'complete',
      sessionId: undefined,
      createdAt: ago(at + 2),
      endedAt: ago(at + 1),
      ...overrides
    })
  })
}

const bands = (): string[] =>
  [...document.querySelectorAll('.band .bandhead .n')].map((head) => head.textContent ?? '')

function bandEl(name: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('.band')].find(
    (found) => found.querySelector('.bandhead .n')?.textContent === name
  )
}

/** The run ids in one band, in the order the band renders them. */
function rowsOf(name: string): string[] {
  return [...(bandEl(name)?.querySelectorAll('.runrow .id') ?? [])].map(
    (cell) => cell.textContent ?? ''
  )
}

const countOf = (name: string): string =>
  bandEl(name)?.querySelector('.bandhead .k')?.textContent ?? ''

const filterBox = (): HTMLInputElement => screen.getByRole('textbox', { name: 'Filter runs' })

const foot = (): HTMLElement | null => screen.queryByRole('button', { name: /^Show \d+ more/ })

function mount(runs: readonly RunRecord[]) {
  const workflowRuns = createScriptedWorkflowRuns(runs)
  render(
    <Shell
      port={createScriptedPort(SNAPSHOT)}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
      workflowRuns={workflowRuns}
    />
  )
  return { workflowRuns }
}

async function toggle(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(document, { key: 'r', metaKey: true })
    await settled()
  })
}

async function open(runs: readonly RunRecord[]) {
  const held = mount(runs)
  await act(settled)
  await toggle()
  return held
}

function type(text: string): void {
  act(() => {
    fireEvent.change(filterBox(), { target: { value: text } })
  })
}

async function escapeFrom(target: Element | Document): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(target, { key: 'Escape' })
    await settled()
  })
}

describe('Done over a long history', () => {
  it('opens on its newest 20 and counts every run it holds', async () => {
    await open(history(45))

    const done = rowsOf('Done')
    expect(done).toHaveLength(20)
    expect(done[0]).toBe('d000')
    expect(done[19]).toBe('d019')
    expect(countOf('Done')).toBe('45')
    expect(foot()).toHaveTextContent('Show 20 more · 25 older')
    // The foot is the last thing in the band.
    expect(bandEl('Done')?.lastElementChild).toBe(foot())
  })

  it('never cuts Running or Needs you', async () => {
    const working = Array.from({ length: 24 }, (_, at) =>
      runOf({ id: `w${String(at).padStart(3, '0')}`, createdAt: ago(at + 1) })
    )
    const asking = Array.from({ length: 23 }, (_, at) =>
      runOf({
        id: `f${String(at).padStart(3, '0')}`,
        status: 'failed',
        createdAt: ago(at + 1),
        endedAt: ago(at)
      })
    )
    await open([...working, ...asking, ...history(21)])

    expect(rowsOf('Running')).toHaveLength(24)
    expect(rowsOf('Needs you')).toHaveLength(23)
    expect(rowsOf('Done')).toHaveLength(20)
    expect(foot()).toHaveTextContent('Show 1 more · 1 older')
  })

  it('adds the next 20 below the rows already drawn, and the last batch says its size', async () => {
    await open(history(51))

    act(() => {
      fireEvent.click(foot() as HTMLElement)
    })
    let done = rowsOf('Done')
    expect(done).toHaveLength(40)
    expect(done.slice(0, 20)).toEqual(history(20).map((run) => run.id))
    expect(done[20]).toBe('d020')
    expect(foot()).toHaveTextContent('Show 11 more · 11 older')

    act(() => {
      fireEvent.click(foot() as HTMLElement)
    })
    done = rowsOf('Done')
    expect(done).toHaveLength(51)
    expect(done[50]).toBe('d050')
    expect(foot()).toBeNull()
    expect(countOf('Done')).toBe('51')
  })

  it('draws no foot when Done fits', async () => {
    await open(history(20))
    expect(rowsOf('Done')).toHaveLength(20)
    expect(foot()).toBeNull()
  })

  it('is back to 20, with nothing filtered, every time ⌘R opens', async () => {
    await open(history(45))
    act(() => {
      fireEvent.click(foot() as HTMLElement)
    })
    expect(rowsOf('Done')).toHaveLength(40)

    await toggle()
    expect(screen.queryByLabelText('Workspace runs')).toBeNull()
    await toggle()

    expect(rowsOf('Done')).toHaveLength(20)
    expect(filterBox()).toHaveValue('')
  })

  it('keeps the headline counting everything, whatever is on screen', async () => {
    await open([runOf({}), ...history(45)])
    const headline = document.querySelector('.gvtop .count')?.textContent
    type('d044')
    expect(document.querySelector('.gvtop .count')?.textContent).toBe(headline)
  })
})

describe('a change to one run', () => {
  it('reaches ⌘R without anything else in the history moving', async () => {
    const working = runOf({ id: 'wk01' })
    const { workflowRuns } = await open([working, ...history(45)])
    expect(bands()).toEqual(['Running', 'Done'])

    // Main sends only the record that changed; the rest are the shell's to keep.
    await act(async () => {
      workflowRuns.setRuns([{ ...working, status: 'complete', endedAt: new Date().toISOString() }])
      await settled()
    })

    expect(bands()).toEqual(['Done'])
    expect(countOf('Done')).toBe('46')
    expect(rowsOf('Done')[0]).toBe('wk01')
    expect(rowsOf('Done')).toHaveLength(20)
  })
})

describe('the filter', () => {
  it('has the focus the moment ⌘R opens', async () => {
    await open(history(3))
    expect(document.activeElement).toBe(filterBox())
  })

  it('reaches runs far past the cap, and lifts the cap while it has text', async () => {
    const old = history(30, { workflow: 'upstream-fix' }).map((run, at) => ({
      ...run,
      id: `u${String(at).padStart(3, '0')}`,
      createdAt: ago(at + 200),
      endedAt: ago(at + 199)
    }))
    await open([...history(100), ...old])
    expect(rowsOf('Done')).not.toContain('u000')

    type('upstream')

    expect(rowsOf('Done')).toEqual(old.map((run) => run.id))
    // While filtering, a band counts its matches.
    expect(countOf('Done')).toBe('30')
    expect(foot()).toBeNull()
  })

  it('matches workflow, repository, run id and session title', async () => {
    const runs = [
      runOf({ id: 'wf01', workflow: 'research', status: 'complete', endedAt: ago(1) }),
      runOf({
        id: 'rp01',
        targetRepository: 'components/kairos-api',
        status: 'complete',
        endedAt: ago(3)
      }),
      runOf({ id: '3566', status: 'complete', endedAt: ago(4) }),
      runOf({ id: 'se01', sessionId: 's2', status: 'complete', endedAt: ago(5) })
    ]
    await open(runs)

    const matching = (text: string): string[] => {
      type(text)
      return rowsOf('Done')
    }
    expect(matching('RESEARCH')).toEqual(['wf01'])
    expect(matching('kairos')).toEqual(['rp01'])
    expect(matching('3566')).toEqual(['3566'])
    expect(matching('rounding')).toEqual(['se01'])
    // Surrounding blanks are not part of what is asked for.
    expect(matching('  3566 ')).toEqual(['3566'])
  })

  it('filters every band, and a band with no match is gone', async () => {
    await open([
      runOf({ id: 'rn01', workflow: 'build' }),
      runOf({ id: 'nd01', workflow: 'adhoc', status: 'failed', endedAt: ago(1) }),
      runOf({ id: 'dn01', workflow: 'adhoc', status: 'complete', endedAt: ago(2) })
    ])
    expect(bands()).toEqual(['Running', 'Needs you', 'Done'])

    type('adhoc')

    expect(bands()).toEqual(['Needs you', 'Done'])
    expect(countOf('Needs you')).toBe('1')
    expect(countOf('Done')).toBe('1')
  })

  it('marks what it matched on each row', async () => {
    await open([runOf({ id: '3566', workflow: 'upstream-fix', status: 'complete', endedAt: ago(1) })])

    type('stream')

    const marks = [...document.querySelectorAll('.runrow mark')].map((mark) => mark.textContent)
    expect(marks).toEqual(['stream'])
    expect(document.querySelector('.runrow .wf')?.textContent).toBe('upstream-fix')
  })

  it('says so when nothing matches, and Clear filter brings every band back', async () => {
    await open([runOf({}), ...history(45)])

    type('zzz-nothing')

    expect(bands()).toEqual([])
    const view = screen.getByLabelText('Workspace runs')
    expect(view).toHaveTextContent('No run matches “zzz-nothing”.')

    act(() => {
      fireEvent.click(within(view).getByRole('button', { name: 'Clear filter' }))
    })

    expect(filterBox()).toHaveValue('')
    expect(bands()).toEqual(['Running', 'Done'])
    expect(rowsOf('Done')).toHaveLength(20)
    expect(document.activeElement).toBe(filterBox())
  })

  it('clears from the × in the box', async () => {
    await open(history(3))
    type('d001')
    expect(rowsOf('Done')).toEqual(['d001'])

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'clear' }))
    })

    expect(filterBox()).toHaveValue('')
    expect(rowsOf('Done')).toHaveLength(3)
    expect(screen.queryByRole('button', { name: 'clear' })).toBeNull()
  })

  it('takes the first Escape to clear itself, and the next one closes ⌘R', async () => {
    await open(history(3))
    type('d001')

    await escapeFrom(filterBox())
    expect(screen.getByLabelText('Workspace runs')).toBeInTheDocument()
    expect(filterBox()).toHaveValue('')
    expect(rowsOf('Done')).toHaveLength(3)

    await escapeFrom(filterBox())
    expect(screen.queryByLabelText('Workspace runs')).toBeNull()
  })
})
