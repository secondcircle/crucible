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
      working: false
    },
    {
      id: 's2',
      workspaceId: 'w1',
      createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      working: false
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

describe('the sidebar row', () => {
  it('is the session title, with the relative time trailing it inline', async () => {
    await shell()

    const [titled] = sessionRows()
    expect(titled).toHaveTextContent(LONG)
    // Inside the clamped block, after the words: never a row of its own.
    expect(titled.querySelector('small')?.textContent).toBe('4m ago')
    expect(titled.lastElementChild?.tagName).toBe('SMALL')
  })

  // Where the clamp itself lives: jsdom loads no stylesheet, so how many lines
  // it renders is checked on the running app, not here.
  it('puts the title, the dot and the time in the one clamped block', async () => {
    await shell()

    const [titled] = sessionRows()
    expect(titled).toHaveClass('sess')
    expect(titled?.querySelector('.dot')).toBeInTheDocument()
    expect(titled?.querySelector('small')).toBeInTheDocument()
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
    expect(untitled.querySelector('small')?.textContent).toBe('30m ago')

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
