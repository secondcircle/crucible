// @vitest-environment jsdom
//
// What the board does when you press something, and when it collects. Every
// input acknowledges in the same frame; nothing here touches the repository.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace, type ScriptedWorkspace } from './testing/scripted-workspace'
import { hostedBoard } from './testing/boards'
import { settled } from './testing/settled'

let copied: string[]

beforeEach(() => {
  copied = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        copied.push(text)
        return Promise.resolve()
      }
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
})

async function shell(
  snapshot: Partial<ShellSnapshot> = oneSession()
): Promise<{ readonly port: ScriptedPort; readonly workspace: ScriptedWorkspace }> {
  const port = createScriptedPort(snapshot)
  const workspace = createScriptedWorkspace()
  workspace.boards.set('/repos/crucible', { kind: 'board', board: hostedBoard() })
  render(<Shell port={port} workspace={workspace} commands={createScriptedCommands()} />)
  await settled()
  return { port, workspace }
}

const board = (): HTMLElement | null => screen.queryByRole('dialog', { name: 'Branch board' })

const box = (): HTMLTextAreaElement => screen.getByLabelText('Message') as HTMLTextAreaElement

const focused = (): string | undefined =>
  document.querySelector('.row.focused')?.getAttribute('aria-label') ?? undefined

const selected = (): string[] =>
  Array.from(document.querySelectorAll('.row.selected')).map(
    (row) => row.getAttribute('aria-label') ?? ''
  )

async function open(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Branch board' }))
  })
}

async function press(key: string, options: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(document, { key, ...options })
  })
}

/** Moves the focus ring down to the named row, however far away it is. */
async function focusRow(name: string): Promise<void> {
  for (let step = 0; step < 20 && focused() !== name; step += 1) await press('ArrowDown')
  expect(focused()).toBe(name)
}

describe('moving around the board', () => {
  it('opens on the first row and moves with the arrows', async () => {
    await shell()
    await open()

    // The most recently touched row of the first group.
    expect(focused()).toBe('build/build-260819-f1wn')

    await press('ArrowDown')
    expect(focused()).toBe('issue-7-roster-parking')

    await press('ArrowUp')
    expect(focused()).toBe('build/build-260819-f1wn')
    // The first row is the top: an arrow past it changes nothing.
    await press('ArrowUp')
    expect(focused()).toBe('build/build-260819-f1wn')
  })

  it('moves the ring to a clicked row and does nothing else', async () => {
    const { workspace } = await shell()
    await open()

    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'role-delegation' }))
    })

    expect(focused()).toBe('role-delegation')
    expect(workspace.calls.map((call) => call.op)).not.toContain('openUrl')
  })
})

describe('who owns the keyboard while the board is open', () => {
  it('takes the focus from whatever had it, and keeps every key it acts on', async () => {
    const { port, workspace } = await shell()
    await act(async () => {
      fireEvent.change(box(), { target: { value: 'a message I was drafting' } })
      box().focus()
    })

    await open()
    expect(document.activeElement).toBe(board())
    await focusRow('issue-7-roster-parking')

    // Pressed where the composer would have heard it: the board acts, and the
    // draft is neither sent nor touched.
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter', bubbles: true })
    })

    expect(port.calls.map((call) => call.op)).not.toContain('prompt')
    expect(box()).toHaveValue('a message I was drafting')
    expect(workspace.calls).toContainEqual({
      op: 'openUrl',
      args: ['https://github.com/x/y/pull/45']
    })
  })
})

describe('opening a pull request', () => {
  it('opens the focused row\u2019s pull request and says so in the same frame', async () => {
    const { workspace } = await shell()
    await open()
    await focusRow('issue-7-roster-parking')

    await press('Enter')

    expect(workspace.calls).toContainEqual({
      op: 'openUrl',
      args: ['https://github.com/x/y/pull/45']
    })
    expect(screen.getByRole('status')).toHaveTextContent('Opening #45 in your browser')
  })

  it('does nothing at all on a row with no pull request', async () => {
    const { workspace } = await shell()
    await open()
    // The board opens on this one, and it has no pull request at all.
    expect(focused()).toBe('build/build-260819-f1wn')

    await press('Enter')

    expect(workspace.calls.map((call) => call.op)).not.toContain('openUrl')
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('copying a branch name', () => {
  it('copies the focused row and confirms it', async () => {
    await shell()
    await open()

    await focusRow('issue-7-roster-parking')

    await press('c', { metaKey: true })

    expect(copied).toEqual(['issue-7-roster-parking'])
    expect(screen.getByRole('status')).toHaveTextContent('Copied issue-7-roster-parking')
  })
})

describe('selecting rows', () => {
  it('toggles with Space, and keeps the row marked', async () => {
    await shell()
    await open()

    await press(' ')
    expect(selected()).toEqual(['build/build-260819-f1wn'])

    await press(' ')
    expect(selected()).toEqual([])
  })

  it('survives a refresh, and drops a row that left the board', async () => {
    const { workspace } = await shell()
    await open()
    await press(' ')
    await focusRow('role-delegation')
    await press(' ')
    expect(selected()).toEqual(['build/build-260819-f1wn', 'role-delegation'])

    // The next collection no longer has role-delegation in it.
    const board = hostedBoard()
    workspace.boards.set('/repos/crucible', {
      kind: 'board',
      board: { ...board, rows: board.rows.filter((row) => row.name !== 'role-delegation') }
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'refresh now' }))
    })
    await settled()

    expect(selected()).toEqual(['build/build-260819-f1wn'])
  })
})

describe('asking about what is selected', () => {
  it('offers the entry only once something is selected', async () => {
    await shell()
    await open()

    expect(document.querySelector('.bfoot')?.textContent).not.toContain('ask about these')

    await press(' ')

    expect(document.querySelector('.bfoot')?.textContent).toContain('⌘⏎ ask about these')
  })

  it('closes the board and seeds the composer, sending nothing', async () => {
    const { port } = await shell()
    await open()
    await focusRow('issue-7-roster-parking')
    await press(' ')
    await focusRow('issue-6-monitor-leads')
    await press(' ')

    await press('Enter', { metaKey: true })

    expect(board()).toBeNull()
    // One name per line, then the empty line the caret sits on.
    expect(box()).toHaveValue('issue-7-roster-parking\nissue-6-monitor-leads\n')
    expect(box().selectionStart).toBe(box().value.length)
    expect(document.activeElement).toBe(box())
    expect(port.calls.map((call) => call.op)).not.toContain('prompt')
  })

  it('keeps a draft already being typed, below the names', async () => {
    await shell()
    await act(async () => {
      fireEvent.change(box(), { target: { value: 'half a sentence' } })
    })
    await open()
    await focusRow('issue-7-roster-parking')
    await press(' ')

    await press('Enter', { metaKey: true })

    expect(box()).toHaveValue('issue-7-roster-parking\n\nhalf a sentence')
    // The caret is on the empty line, above what was already there.
    expect(box().selectionStart).toBe('issue-7-roster-parking\n'.length)
  })

  it('says there is no session to ask, and stays usable', async () => {
    await shell({
      workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
      activeWorkspaceId: 'w1',
      sessions: []
    })
    await open()
    await press(' ')

    expect(document.querySelector('.bfoot .ask')?.className).toContain('dim')
    expect(document.querySelector('.bfoot')?.textContent).toContain('no session open')

    await press('Enter', { metaKey: true })

    expect(board()).not.toBeNull()
  })
})

describe('when the board collects', () => {
  it('collects when the workspace becomes active, and again when the board opens', async () => {
    const { workspace } = await shell()
    expect(workspace.calls).toEqual([{ op: 'branchBoard', args: ['/repos/crucible'] }])

    await open()

    expect(
      workspace.calls.filter((call) => call.op === 'branchBoard')
    ).toHaveLength(2)
  })

  it('collects again when asked, and says it is doing it', async () => {
    const { workspace } = await shell()
    await open()
    workspace.holdBoard = true

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'refresh now' }))
    })

    // The link is gone for the whole collection, not just its first frame.
    expect(screen.getByText('refreshing…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'refresh now' })).toBeNull()

    await act(async () => {
      workspace.settleBoard()
    })
    await settled()

    expect(screen.getByRole('button', { name: 'refresh now' })).toBeInTheDocument()
    expect(screen.getByText(/refreshed 0s ago/)).toBeInTheDocument()
  })

  it('skips a workspace whose session is working, and retries on the next trigger', async () => {
    const { port, workspace } = await shell()
    const before = workspace.calls.length
    // Focused, so the sweep this test drives is one the app would really run.
    await act(async () => {
      fireEvent.focus(window)
    })
    await settled()
    expect(workspace.calls.length).toBeGreaterThan(before)
    const collected = workspace.calls.length

    await act(async () => {
      await port.prompt('s1', 'go')
    })
    await act(async () => {
      fireEvent.focus(window)
    })
    await settled()

    expect(workspace.calls).toHaveLength(collected)

    await act(async () => {
      port.endTurn('s1')
    })
    await act(async () => {
      fireEvent.focus(window)
    })
    await settled()

    expect(workspace.calls.length).toBeGreaterThan(collected)
  })

  it('keeps the last good snapshot when a collection fails, and says both', async () => {
    const { workspace } = await shell()
    await open()
    workspace.boardRefusal = 'gh could not reach github.com.'

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'refresh now' }))
    })
    await settled()

    // The board still stands, with its true age, and the failure is said
    // twice: on the board, and on the shell's own failure line.
    expect(screen.getByRole('option', { name: 'issue-7-roster-parking' })).toBeInTheDocument()
    expect(screen.getByText(/refreshed 0s ago/)).toBeInTheDocument()
    expect(document.querySelector('.bsub .staleword')?.textContent).toBe(
      "couldn't refresh — gh could not reach github.com."
    )
    expect(document.querySelector('.failure')?.textContent).toBe(
      'gh could not reach github.com.'
    )
  })

  it('polls every minute while the window is focused, and not at all otherwise', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const port = createScriptedPort(oneSession())
    const workspace = createScriptedWorkspace()
    workspace.boards.set('/repos/crucible', { kind: 'board', board: hostedBoard() })
    render(<Shell port={port} workspace={workspace} commands={createScriptedCommands()} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    // Regaining the focus is a trigger of its own.
    await act(async () => {
      fireEvent.focus(window)
      await vi.advanceTimersByTimeAsync(0)
    })
    const before = workspace.calls.length

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(workspace.calls.length).toBe(before + 1)

    // An unfocused window collects nothing at all.
    await act(async () => {
      fireEvent.blur(window)
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(workspace.calls.length).toBe(before + 1)
  })
})

describe('what the board never does', () => {
  it('offers no control that touches the repository', async () => {
    await shell()
    await open()
    const text = board()?.textContent ?? ''

    for (const forbidden of ['Delete', 'delete this', 'Check out', 'Push', 'Prune']) {
      expect(text).not.toContain(forbidden)
    }
    expect(text).toContain('nothing here is deleted for you')
    // Every button on the board, and nothing beyond what is enumerated.
    expect(
      Array.from(board()?.querySelectorAll('button') ?? []).map((button) =>
        (button.textContent ?? '').trim()
      )
    ).toEqual(['Close esc', "show everyone's", 'refresh now'])
  })
})
