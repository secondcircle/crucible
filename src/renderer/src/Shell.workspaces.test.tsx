// @vitest-environment jsdom
//
// The workspace list as the user reads it: the two bands and the hairline
// between them, the chevron that folds a workspace, what a folded row keeps
// saying, and Collapse idle. Driven through the same seams every other sidebar
// behavior is — a scripted port, scripted runs, scripted monitors — because the
// snapshot is the only thing the list reads any of it from.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionState, ShellSnapshot } from '../../shared/agent/port'
import type { LiveMonitor } from '../../shared/monitors/monitor'
import type { RunRecord } from '../../shared/workflows/run'
import { Shell } from './Shell'
import { memoryFoldedStore, type FoldedStore } from './sidebar/folded-store'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedMonitors } from './testing/scripted-monitors'
import { createScriptedPort, type ScriptedPort } from './testing/scripted-port'
import {
  createScriptedWorkflowRuns,
  type ScriptedWorkflowRuns
} from './testing/scripted-workflow-runs'
import { createScriptedWorkspace, type ScriptedWorkspace } from './testing/scripted-workspace'
import { hostedBoard } from './testing/boards'
import { settled } from './testing/settled'

const HOUR = 3_600_000
const DAY = 24 * HOUR

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()

const HERE = 'Wiring the composer to the agent port'
const BESIDE = 'Quota strip rounds the wrong way past $10'
const POOL = 'Update the financing page with the new rates'
const CAMP = 'Reviewing the mattress and pad options'
const MONEY = 'Financial review confirming the tax payment posted'

function session(id: string, workspaceId: string, title: string): SessionState {
  return { id, workspaceId, createdAt: ago(3 * DAY), title, working: false, fresh: false }
}

// Five workspaces in the order they were added, whose stamps put them in an
// order the add order cannot produce: two used in the last day, two older, one
// never used at all.
function snapshotOf(): ShellSnapshot {
  return {
    workspaces: [
      { id: 'w1', name: 'crucible', path: '/repos/crucible', lastUsedAt: ago(HOUR) },
      { id: 'w2', name: 'baypool', path: '/repos/baypool', lastUsedAt: ago(2 * HOUR) },
      { id: 'w3', name: 'camping', path: '/repos/camping', lastUsedAt: ago(10 * DAY) },
      { id: 'w4', name: 'financial', path: '/repos/financial', lastUsedAt: ago(7 * DAY) },
      { id: 'w5', name: 'train-4-tomorrow', path: '/repos/train-4-tomorrow' }
    ],
    activeWorkspaceId: 'w1',
    activeSessionId: 's1',
    sessions: [
      session('s1', 'w1', HERE),
      session('s2', 'w1', BESIDE),
      session('s3', 'w2', POOL),
      session('s4', 'w3', CAMP),
      session('s5', 'w4', MONEY)
    ]
  }
}

/** The order the bands put the fixture in, which is not the order it was added. */
const SETTLED = ['baypool', 'crucible', 'financial', 'camping', 'train-4-tomorrow']

interface Rig {
  readonly port: ScriptedPort
  readonly workflowRuns: ScriptedWorkflowRuns
  readonly workspace: ScriptedWorkspace
  readonly folded: FoldedStore
}

async function sidebar(
  options: {
    readonly snapshot?: ShellSnapshot
    readonly runs?: readonly RunRecord[]
    readonly monitors?: readonly LiveMonitor[]
    readonly folded?: FoldedStore
    readonly set?: (workspace: ScriptedWorkspace) => void
    /** A list with no rows to wait for; the label row is what arrives instead. */
    readonly empty?: boolean
  } = {}
): Promise<Rig> {
  const port = createScriptedPort(options.snapshot ?? snapshotOf())
  const workflowRuns = createScriptedWorkflowRuns(options.runs ?? [])
  const monitors = createScriptedMonitors(options.monitors ?? [])
  const workspace = createScriptedWorkspace()
  const folded = options.folded ?? memoryFoldedStore()
  options.set?.(workspace)
  render(
    <Shell
      port={port}
      workspace={workspace}
      commands={createScriptedCommands()}
      workflowRuns={workflowRuns}
      monitors={monitors}
      folded={folded}
    />
  )
  await screen.findByRole('button', {
    name: options.empty === true ? 'Collapse idle' : 'crucible'
  })
  await settled()
  return { port, workflowRuns, workspace, folded }
}

const listed = (): string[] =>
  [...document.querySelectorAll('.side .wsname')].map((row) => row.textContent ?? '')

function rowOf(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('.side .wsname')].find(
    (row) => row.textContent === name
  )
  const row = found?.closest('.ws')
  if (!(row instanceof HTMLElement)) throw new Error(`no workspace row for ${name}`)
  return row
}

const nameButton = (name: string): HTMLElement =>
  screen.getByRole('button', { name: (label) => label === name || label === `${name} (working)` })

function chevron(name: string): HTMLElement {
  const found = rowOf(name).querySelector('.chev')
  if (!(found instanceof HTMLElement)) throw new Error(`no chevron on ${name}`)
  return found
}

const collapseIdle = (): HTMLElement => screen.getByRole('button', { name: 'Collapse idle' })

const folded = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('.side .ws.folded .wsname')].map(
    (row) => row.textContent ?? ''
  )

const sessionTitles = (): string[] =>
  [...document.querySelectorAll('.side .sess .sesstext')].map((row) => row.textContent ?? '')

function fold(name: string): void {
  fireEvent.click(chevron(name))
}

/** A whole turn in one session, start to finish. */
async function turn(port: ScriptedPort, sessionId: string): Promise<void> {
  await act(async () => {
    await port.prompt(sessionId, 'go')
  })
  act(() => port.endTurn(sessionId))
  await settled()
}

function runOf(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'en42',
    workflow: 'build',
    status: 'running',
    workspacePath: '/repos/camping',
    workspaceName: 'camping',
    sessionId: 's4',
    inputs: {},
    nodes: [],
    createdAt: ago(20 * 60_000),
    startedAt: ago(20 * 60_000),
    ...overrides
  }
}

function monitorOf(sessionId: string): LiveMonitor {
  return {
    id: 'm1',
    sessionId,
    description: 'CI on PR #482 to finish',
    reason: 'the branch cannot merge until it is green',
    command: 'gh pr checks 482',
    cwd: '/repos/camping',
    intervalMs: 30_000,
    timeoutMs: 30 * 60_000,
    setAt: ago(5 * 60_000),
    checks: 4
  }
}

afterEach(() => {
  cleanup()
})

describe('the order the list is in', () => {
  it('is decided by use and by name, not by the order folders were added', async () => {
    await sidebar()

    expect(listed()).toEqual(SETTLED)
  })

  it('draws one hairline, on the first row below it, with nothing announced there', async () => {
    await sidebar()

    expect(document.querySelectorAll('.side .ws.bandstart')).toHaveLength(1)
    expect(rowOf('financial')).toHaveClass('bandstart')
    // One list item per workspace and no other: the line is drawn on a row.
    expect(document.querySelectorAll('.side .wslist > li')).toHaveLength(5)
    expect(screen.getAllByRole('listitem').filter((item) => item.textContent === '')).toEqual([])
  })

  it('drops the hairline when a band empties', async () => {
    await sidebar({
      snapshot: {
        ...snapshotOf(),
        workspaces: [
          { id: 'w1', name: 'crucible', path: '/repos/crucible', lastUsedAt: ago(HOUR) },
          { id: 'w2', name: 'baypool', path: '/repos/baypool', lastUsedAt: ago(2 * HOUR) }
        ]
      }
    })

    expect(document.querySelectorAll('.side .ws.bandstart')).toHaveLength(0)
  })

  it('moves a workspace into the recent band the moment work starts there, with no click', async () => {
    const { port } = await sidebar()

    await act(async () => {
      await port.prompt('s4', 'go')
    })

    expect(listed()).toEqual(['baypool', 'camping', 'crucible', 'financial', 'train-4-tomorrow'])
  })

  it('lands a freshly added workspace at the bottom, because adding is not using', async () => {
    const { port } = await sidebar()
    port.folder = '/repos/zeppelin'

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '＋ Add workspace' }))
      await settled()
    })

    expect(listed().at(-1)).toBe('zeppelin')
  })

  it('leaves every other row where it was when a workspace is removed', async () => {
    const { port } = await sidebar()

    await act(async () => {
      await port.removeWorkspace('w4')
    })

    expect(listed()).toEqual(['baypool', 'crucible', 'camping', 'train-4-tomorrow'])
  })

  it('reorders nothing anywhere else: the runs overview keeps its own order', async () => {
    await sidebar({
      runs: [
        runOf({ id: 'en1', status: 'complete', endedAt: ago(60_000) }),
        runOf({
          id: 'en2',
          status: 'complete',
          endedAt: ago(20 * 60_000),
          sessionId: 's3',
          workspacePath: '/repos/baypool',
          workspaceName: 'baypool'
        })
      ]
    })

    await act(async () => {
      fireEvent.keyDown(document, { key: 'r', metaKey: true })
      await settled()
    })

    expect(listed()).toEqual(['baypool', 'camping', 'crucible', 'financial', 'train-4-tomorrow'])
    expect([...document.querySelectorAll('.runrow .ws')].map((row) => row.textContent)).toEqual([
      'camping',
      'baypool'
    ])
  })
})

describe('crossing the 24-hour line', () => {
  it('moves the workspace once, within a minute, with nobody touching anything', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const snapshot = snapshotOf()
      await sidebar({
        snapshot: {
          ...snapshot,
          workspaces: snapshot.workspaces.map((workspace) =>
            workspace.id === 'w1'
              ? { ...workspace, lastUsedAt: ago(DAY - 20_000) }
              : workspace
          )
        }
      })
      expect(listed()).toEqual(SETTLED)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000)
      })
      expect(listed()).toEqual(['baypool', 'crucible', 'financial', 'camping', 'train-4-tomorrow'])

      // Once: the next tick finds it already where the crossing left it.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000)
      })
      expect(listed()).toEqual(['baypool', 'crucible', 'financial', 'camping', 'train-4-tomorrow'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('folding a workspace', () => {
  it('gives every row a chevron, including a workspace with no sessions', async () => {
    await sidebar()

    expect(document.querySelectorAll('.side .chev')).toHaveLength(5)
    expect(chevron('train-4-tomorrow')).toBeInTheDocument()
  })

  it('hides the session rows and, on the active workspace, Resume session…', async () => {
    await sidebar()
    expect(screen.getByRole('button', { name: 'Resume session…' })).toBeInTheDocument()

    fold('crucible')

    expect(sessionTitles()).toEqual([POOL, MONEY, CAMP])
    expect(screen.queryByRole('button', { name: 'Resume session…' })).toBeNull()
    expect(nameButton('crucible')).toBeInTheDocument()
  })

  it('changes nothing else: not the active workspace, not the order', async () => {
    const { port } = await sidebar()

    fold('camping')

    expect(listed()).toEqual(SETTLED)
    expect(nameButton('crucible')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: HERE })).toHaveAttribute('aria-current', 'true')
    expect(port.calls.filter((call) => call.op === 'activateWorkspace')).toEqual([])
  })

  it('folds one workspace and leaves every other one as it was', async () => {
    await sidebar()

    fold('camping')
    fold('financial')
    fold('camping')

    expect(folded()).toEqual(['financial'])
  })

  it('keeps the dot, the amber count and the board\u2019s count on the folded row', async () => {
    const { port } = await sidebar({
      set: (workspace) => {
        workspace.boards.set('/repos/crucible', { kind: 'board', board: hostedBoard() })
      }
    })
    await turn(port, 's2')
    const board = await screen.findByTitle(/need you in crucible/)

    fold('crucible')

    const row = rowOf('crucible')
    expect(row).toHaveClass('folded')
    expect(row.querySelector('.dot')).not.toBeNull()
    expect(row.querySelector('.wsn')).toHaveTextContent('1')
    expect(screen.getByTitle('1 session waiting on you in crucible')).toBeInTheDocument()
    expect(row.querySelector('.n')).toHaveTextContent(board.textContent ?? '')
  })

  it('lights the folded row\u2019s dot while a turn or a live run works inside', async () => {
    const { port, workflowRuns } = await sidebar()

    fold('camping')
    await act(async () => {
      await port.prompt('s4', 'go')
    })
    expect(rowOf('camping')).toHaveClass('working')

    act(() => port.endTurn('s4'))
    await settled()
    expect(rowOf('camping')).not.toHaveClass('working')

    act(() => workflowRuns.setRuns([runOf({ status: 'paused' })]))
    await settled()
    expect(rowOf('camping')).toHaveClass('working')
  })

  it('opens a folded workspace when its name is clicked, and activates it', async () => {
    const { port } = await sidebar()
    fold('camping')

    await act(async () => {
      fireEvent.click(nameButton('camping'))
      await settled()
    })

    expect(folded()).toEqual([])
    expect(port.calls.filter((call) => call.op === 'activateWorkspace')).toEqual([
      { op: 'activateWorkspace', args: ['w3'] }
    ])
  })

  it('never folds a workspace whose name is clicked while it is open', async () => {
    await sidebar()

    await act(async () => {
      fireEvent.click(nameButton('camping'))
      await settled()
    })

    expect(folded()).toEqual([])
  })

  it('unfolds for nothing on its own: not work, not a mark, not an activation', async () => {
    const { port, workflowRuns } = await sidebar()
    fold('camping')

    await act(async () => {
      await port.prompt('s4', 'go')
    })
    act(() => workflowRuns.setRuns([runOf({ status: 'running' })]))
    await settled()
    act(() => port.endTurn('s4'))
    await settled()
    await act(async () => {
      await port.activateSession('s4')
      await settled()
    })

    expect(folded()).toEqual(['camping'])
  })

  it('renders the sessions of an open workspace exactly as before', async () => {
    await sidebar()

    fold('camping')

    expect(sessionTitles()).toEqual([POOL, HERE, BESIDE, MONEY])
    expect(screen.getByRole('button', { name: HERE })).toHaveAttribute('aria-current', 'true')
  })
})

describe('the count on a folded row', () => {
  const countOf = (name: string): string | undefined =>
    rowOf(name).querySelector('.wsc')?.textContent ?? undefined

  it('says how many session rows the fold hid, and not the Resume row', async () => {
    await sidebar()

    fold('crucible')

    expect(countOf('crucible')).toBe('2')
  })

  it('shows none for a workspace with no sessions', async () => {
    await sidebar()

    fold('train-4-tomorrow')

    expect(countOf('train-4-tomorrow')).toBeUndefined()
  })

  it('shows none at all while the workspace is open', async () => {
    await sidebar()

    expect(countOf('crucible')).toBeUndefined()
  })

  it('follows the sessions while the workspace stays folded', async () => {
    const { port } = await sidebar()
    fold('camping')
    expect(countOf('camping')).toBe('1')

    act(() =>
      port.update((snapshot) => ({
        ...snapshot,
        sessions: [...snapshot.sessions, session('s6', 'w3', 'A second camping session')]
      }))
    )
    expect(countOf('camping')).toBe('2')

    act(() =>
      port.update((snapshot) => ({
        ...snapshot,
        sessions: snapshot.sessions.filter((held) => held.workspaceId !== 'w3')
      }))
    )
    expect(countOf('camping')).toBeUndefined()
  })

  it('sits beside the other counts, with the remove control still over them', async () => {
    const { port } = await sidebar()
    await turn(port, 's4')

    fold('camping')

    const row = rowOf('camping')
    expect([...row.children].map((child) => child.className)).toEqual([
      'chev',
      'wsname',
      'wsc',
      'wsn',
      'rowaction'
    ])
    // Unbordered and unfilled, which is what tells it from the two pills.
    expect(row.querySelector('.wsc')).not.toHaveClass('n')
    expect(row.querySelector('.wsc')).not.toHaveClass('wsn')
  })

  it('says what it counts, for a reader who cannot see the fold', async () => {
    await sidebar()

    fold('crucible')

    expect(screen.getByTitle('2 sessions folded in crucible')).toHaveTextContent('2')
  })
})

describe('Collapse idle', () => {
  it('sits on the WORKSPACES label row and says what it folds', async () => {
    await sidebar()

    const head = document.querySelector('.side .wshead')
    expect(head?.querySelector('.wslabel')).toHaveTextContent('Workspaces')
    expect(head?.contains(collapseIdle())).toBe(true)
    expect(collapseIdle()).toHaveAttribute(
      'title',
      'Collapse every workspace with nothing working, waiting on you, or in front of you'
    )
  })

  it('folds every workspace that is not in use, in one click', async () => {
    const { port, workflowRuns } = await sidebar()
    // A turn working in one, a paused run in another, a session needing you in
    // a third, and the one on screen.
    await act(async () => {
      await port.prompt('s3', 'go')
    })
    act(() => workflowRuns.setRuns([runOf({ status: 'paused' })]))
    await settled()
    await turn(port, 's5')

    fireEvent.click(collapseIdle())

    expect(folded()).toEqual(['train-4-tomorrow'])
    // Folding moved nothing. The band camping is in came from its run having
    // worked twenty minutes ago, which was true before the click too.
    expect(listed()).toEqual([
      'baypool',
      'camping',
      'crucible',
      'financial',
      'train-4-tomorrow'
    ])
  })

  it('folds a workspace whose only wait is a monitor', async () => {
    await sidebar({ monitors: [monitorOf('s4')] })

    fireEvent.click(collapseIdle())

    expect(folded().sort()).toEqual(['baypool', 'camping', 'financial', 'train-4-tomorrow'])
  })

  it('unfolds nothing on its way', async () => {
    const { port } = await sidebar()
    fold('baypool')
    await act(async () => {
      await port.prompt('s3', 'go')
    })

    fireEvent.click(collapseIdle())

    expect(folded()).toContain('baypool')
  })

  it('is a one-shot action and not a mode', async () => {
    const { port } = await sidebar()
    fireEvent.click(collapseIdle())
    expect(folded().sort()).toEqual(['baypool', 'camping', 'financial', 'train-4-tomorrow'])

    // A folded workspace coming into use stays folded, and the open one that
    // goes idle stays open.
    await act(async () => {
      await port.prompt('s4', 'go')
    })
    await act(async () => {
      await port.activateWorkspace('w2')
      await settled()
    })

    expect(folded()).toContain('camping')
    expect(folded()).not.toContain('crucible')
  })

  it('is disabled exactly when nothing is left to fold', async () => {
    await sidebar()
    expect(collapseIdle()).toHaveAttribute('aria-disabled', 'false')

    fireEvent.click(collapseIdle())
    expect(collapseIdle()).toHaveAttribute('aria-disabled', 'true')

    // And a disabled control does nothing when it is clicked anyway.
    const held = folded()
    fireEvent.click(collapseIdle())
    expect(folded()).toEqual(held)
  })

  it('is disabled where there are no workspaces at all', async () => {
    await sidebar({ snapshot: { workspaces: [], sessions: [] }, empty: true })

    expect(collapseIdle()).toHaveAttribute('aria-disabled', 'true')
  })

  it('comes back the moment an idle workspace is unfolded', async () => {
    await sidebar()
    fireEvent.click(collapseIdle())
    expect(collapseIdle()).toHaveAttribute('aria-disabled', 'true')

    fold('camping')

    expect(collapseIdle()).toHaveAttribute('aria-disabled', 'false')
  })
})

describe('what a relaunch remembers', () => {
  it('folds the same workspaces again', async () => {
    const store = memoryFoldedStore()
    await sidebar({ folded: store })
    fold('camping')
    fold('financial')

    cleanup()
    await sidebar({ folded: store })

    expect(folded().sort()).toEqual(['camping', 'financial'])
  })

  it('leaves every other workspace\u2019s state alone when one is removed', async () => {
    const store = memoryFoldedStore()
    const { port } = await sidebar({ folded: store })
    fold('camping')
    fold('financial')

    await act(async () => {
      await port.removeWorkspace('w3')
    })
    expect(folded()).toEqual(['financial'])

    // The record is tidied on the next write: meanwhile the id of a workspace
    // that is gone matches nothing.
    fold('baypool')
    expect([...store.read()].sort()).toEqual(['w2', 'w4'])
  })

  it('renders no row and no error for a record naming a workspace that is gone', async () => {
    await sidebar({ folded: memoryFoldedStore(['w9', 'w3']) })

    expect(listed()).toEqual(SETTLED)
    expect(folded()).toEqual(['camping'])
  })

  it('renders everything open when the record cannot be read', async () => {
    await sidebar({
      folded: {
        read: () => new Set(),
        write: () => {}
      }
    })

    expect(folded()).toEqual([])
  })
})

describe('the list, the foot and the scrollbar', () => {
  it('scrolls the list alone, with the head above it and the foot below', async () => {
    await sidebar({
      set: (workspace) => {
        workspace.boards.set('/repos/crucible', { kind: 'board', board: hostedBoard() })
      }
    })

    const side = document.querySelector('.side')
    const list = document.querySelector('.side .wslist')
    expect(list?.parentElement).toBe(side)
    expect(document.querySelector('.side .wshead')?.parentElement).toBe(side)
    expect(document.querySelector('.side .sidefoot')?.parentElement).toBe(side)
    expect(list?.querySelector('.sidefoot')).toBeNull()
    expect(screen.getByRole('button', { name: '＋ Add workspace' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
  })
})

describe('the keyboard and the screen reader', () => {
  it('gives the chevron a real button, a state and a name that says what it does', async () => {
    await sidebar()

    expect(chevron('camping').tagName).toBe('BUTTON')
    expect(chevron('camping')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Collapse camping' })).toBeInTheDocument()

    fold('camping')

    expect(chevron('camping')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'Expand camping' })).toBeInTheDocument()
  })

  it('keeps Collapse idle a real button in the tab order', async () => {
    await sidebar()

    expect(collapseIdle().tagName).toBe('BUTTON')
    expect(collapseIdle()).not.toHaveAttribute('tabindex')
    expect(collapseIdle()).not.toHaveAttribute('disabled')
  })

  it('leaves focus where the click landed, folding and collapsing alike', async () => {
    await sidebar()
    const chev = chevron('camping')
    chev.focus()

    fireEvent.click(chev)
    expect(document.activeElement).toBe(chevron('camping'))

    fireEvent.click(chev)
    expect(document.activeElement).toBe(chevron('camping'))

    collapseIdle().focus()
    fireEvent.click(collapseIdle())
    expect(collapseIdle()).toHaveAttribute('aria-disabled', 'true')
    expect(document.activeElement).toBe(collapseIdle())
  })

  it('shows the result in the frame the click lands, with nothing awaited', async () => {
    await sidebar()

    fireEvent.click(chevron('camping'))
    expect(folded()).toEqual(['camping'])

    fireEvent.click(collapseIdle())
    expect(folded().sort()).toEqual(['baypool', 'camping', 'financial', 'train-4-tomorrow'])
  })
})

describe('the Tab walk', () => {
  it('visits sessions in the order the sidebar shows them', async () => {
    const { port } = await sidebar()
    // Marked in one order, displayed in another: financial sits above camping.
    await turn(port, 's4')
    await turn(port, 's5')

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Tab' })
      await settled()
    })

    expect(port.calls.filter((call) => call.op === 'activateSession')).toEqual([
      { op: 'activateSession', args: ['s5'] }
    ])
  })

  it('lands inside a folded workspace, clears the mark and leaves it folded', async () => {
    const { port } = await sidebar()
    await turn(port, 's4')
    fold('camping')
    expect(rowOf('camping').querySelector('.wsn')).toHaveTextContent('1')

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Tab' })
      await settled()
    })

    expect(port.calls.filter((call) => call.op === 'activateSession')).toEqual([
      { op: 'activateSession', args: ['s4'] }
    ])
    expect(folded()).toEqual(['camping'])
    expect(rowOf('camping').querySelector('.wsn')).toBeNull()
  })
})
