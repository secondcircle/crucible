// @vitest-environment jsdom
//
// A column of running sessions is scanned, not read, so a row says what its
// session is about and how long ago it was active.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import { Shell } from './Shell'
import { createScriptedPort, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { createScriptedCommands } from './testing/scripted-commands'
import { sessionRows, sessionsShown } from './testing/sidebar'
import { settled } from './testing/settled'

const LONG =
  'Removing the composer hint bar, aliasing model names on the chip and ' +
  'writing session titles with a small model'

const SESSIONS: ShellSnapshot = {
  workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
  activeWorkspaceId: 'w1',
  sessions: [
    {
      id: 's1',
      workspaceId: 'w1',
      createdAt: '2026-08-19T14:14:00.000Z',
      lastActivityAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      title: LONG,
      working: false,
      fresh: false
    },
    {
      id: 's2',
      workspaceId: 'w1',
      createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      working: false,
      fresh: false
    }
  ],
  activeSessionId: 's1'
}

async function shell(snapshot: ShellSnapshot = SESSIONS): Promise<ScriptedPort> {
  const port = createScriptedPort(snapshot)
  port.models = [{ id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off'] }]
  render(<Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />)
  await sessionsShown()
  await settled()
  return port
}

// The right-hand slot of a row: the relative time, and the remove button
// stacked over it.
function rowEnd(row: HTMLElement): HTMLElement {
  const end = row.closest('.sessrow')?.querySelector<HTMLElement>('.rowend')
  if (!end) throw new Error('the row has no .rowend slot')
  return end
}

describe('the sidebar row', () => {
  it('is the session title, with the relative time in a slot beside it', async () => {
    await shell()

    const [titled] = sessionRows()
    expect(titled).toHaveTextContent(LONG)
    // Outside the clamp, so a title long enough to fill it keeps its time.
    expect(titled.querySelector('small')).toBeNull()
    expect(rowEnd(titled).querySelector('small')?.textContent).toBe('4m ago')
  })

  // Where the clamp itself lives: jsdom loads no stylesheet, so how many lines
  // it renders is checked on the running app, not here.
  it('puts the title in the clamped block, alone, with the time out of it', async () => {
    await shell()

    const [titled] = sessionRows()
    expect(titled).toHaveClass('sess')
    expect(titled.querySelector('.sesstext')).toHaveTextContent(LONG)
    // No status glyph precedes the title: every row starts on one left edge,
    // and state is carried by the slab and the right-hand slot instead.
    expect(titled.querySelector('.sesstext .dot')).toBeNull()
  })

  it('shares that slot with the remove button, which covers the time', async () => {
    await shell()

    const end = rowEnd(sessionRows()[0])
    expect(within(end).getByRole('button', { name: `Remove ${LONG}` })).toHaveClass('rowaction')
  })

  it('carries the whole title as a tooltip, clipped or not', async () => {
    await shell()

    expect(sessionRows()[0]).toHaveAttribute('title', LONG)
    expect(sessionRows()[1]).toHaveAttribute('title', 'New session')
  })

  it('reads New session, in its own style, until the first title lands', async () => {
    const port = await shell()
    const [, untitled] = sessionRows()

    expect(untitled).toHaveTextContent('New session')
    expect(untitled).toHaveClass('untitled')
    expect(rowEnd(untitled).querySelector('small')?.textContent).toBe('30m ago')

    act(() =>
      port.update((snapshot) => ({
        ...snapshot,
        sessions: snapshot.sessions.map((session) =>
          session.id === 's2' ? { ...session, title: 'Naming sessions from their messages' } : session
        )
      }))
    )

    expect(sessionRows()[1]).toHaveTextContent('Naming sessions from their messages')
    expect(sessionRows()[1]).not.toHaveClass('untitled')
  })

  it('names the session for a screen reader, working state included', async () => {
    const port = await shell()

    expect(screen.getByRole('button', { name: LONG })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: `Remove ${LONG}` })).toBeInTheDocument()

    await act(async () => {
      await port.prompt('s1', 'go')
    })

    expect(screen.getByRole('button', { name: `${LONG} (working)` })).toBeInTheDocument()
  })

  // Viewing and working are told apart by kind, not by shade: one is a slab
  // that holds still, the other is the only thing in the row that moves.
  it('marks the row being looked at as a slab, and only that one', async () => {
    const port = await shell()

    const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.side .sessrow')]
    expect(rows().map((row) => row.classList.contains('viewing'))).toEqual([true, false])

    act(() => port.update((snapshot) => ({ ...snapshot, activeSessionId: 's2' })))

    expect(rows().map((row) => row.classList.contains('viewing'))).toEqual([false, true])
  })

  it('counts up from the turn it is running, in place of how long ago', async () => {
    const port = await shell()

    expect(rowEnd(sessionRows()[0]).querySelector('.elapsed')).toBeNull()

    act(() =>
      port.update((snapshot) => ({
        ...snapshot,
        sessions: snapshot.sessions.map((session) =>
          session.id === 's1'
            ? {
                ...session,
                working: true,
                // Half a second clear of the boundary: the rail's clock was
                // read at render and is a few ms behind this line.
                workingSince: new Date(Date.now() - 134_500).toISOString()
              }
            : session
        )
      }))
    )

    const end = rowEnd(sessionRows()[0])
    expect(end.querySelector('.elapsed')?.textContent).toBe('2:14')
    // One question, one answer: the relative time is gone for the length of
    // the turn, and the dots say what the counter is counting.
    expect(end.querySelector('small')).toBeNull()
    expect(end.querySelectorAll('.typing i')).toHaveLength(3)
    // The idle row keeps its relative time and grows nothing that moves.
    expect(rowEnd(sessionRows()[1]).querySelector('small')?.textContent).toBe('30m ago')
    expect(rowEnd(sessionRows()[1]).querySelector('.typing')).toBeNull()
  })

  it('offers no way to rename a session, anywhere', async () => {
    await shell()

    fireEvent.click(screen.getByRole('button', { name: 'Session menu' }))

    expect(screen.queryByRole('button', { name: /rename/i })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /rename/i })).toBeNull()
    expect(screen.queryByRole('textbox', { name: /title|name/i })).toBeNull()
  })
})

describe('the Usage tab', () => {
  it('names the sessions the same way the sidebar does', async () => {
    await shell()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Session cost' }))
    })

    const table = screen.getByRole('table', { name: 'Sessions in this workspace' })
    const names = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.querySelector('td')?.textContent)
    expect(names).toEqual([LONG, 'New session', 'Workspace total'])
  })
})
