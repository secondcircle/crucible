// @vitest-environment jsdom
//
// Two sessions stream at once here, because losing or mixing their items is the
// failure this arrangement invites.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import { Shell } from './Shell'
import { createScriptedPort, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { createScriptedCommands } from './testing/scripted-commands'
import { settled } from './testing/settled'

// Each session is named by its title, which is what the sidebar shows and what
// a person tells two running sessions apart by.
const FIRST = 'Wiring the composer to the agent port'
const SECOND = 'Fixing the context panel divider drag'

const TWO_SESSIONS: ShellSnapshot = {
  workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
  activeWorkspaceId: 'w1',
  sessions: [
    {
      id: 's1',
      workspaceId: 'w1',
      createdAt: '2026-08-19T14:14:00.000Z',
      title: FIRST,
      working: false
    },
    {
      id: 's2',
      workspaceId: 'w1',
      createdAt: '2026-08-19T15:20:00.000Z',
      title: SECOND,
      working: false
    }
  ],
  activeSessionId: 's1'
}

async function twoStreamingSessions(): Promise<ScriptedPort> {
  const port = createScriptedPort(TWO_SESSIONS)
  render(<Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />)
  await screen.findByRole('button', { name: FIRST })
  await settled()

  await act(async () => {
    await port.prompt('s1', 'the first')
    await port.prompt('s2', 'the second')
  })
  act(() => {
    port.text('s1', 'answering the first')
    port.text('s2', 'answering the second')
  })
  return port
}

function activate(label: string): void {
  fireEvent.click(screen.getByRole('button', { name: (name) => name.startsWith(label) }))
}

describe('two sessions working at once', () => {
  it('shows each transcript only in its own session', async () => {
    await twoStreamingSessions()

    expect(screen.getByText('answering the first')).toBeInTheDocument()
    expect(screen.queryByText('answering the second')).toBeNull()

    await act(async () => activate(SECOND))

    expect(screen.getByText('answering the second')).toBeInTheDocument()
    expect(screen.queryByText('answering the first')).toBeNull()
  })

  it('keeps the stream a switch left behind, and has it whole on return', async () => {
    const port = await twoStreamingSessions()

    await act(async () => activate(SECOND))
    // The session nobody is looking at keeps streaming.
    act(() => port.text('s1', ' — and its second half'))
    await act(async () => activate(FIRST))

    expect(screen.getByText('answering the first — and its second half')).toBeInTheDocument()
    expect(port.calls.map((call) => call.op)).not.toContain('cancel')
  })

  it('tells the truth about which session is working', async () => {
    const port = await twoStreamingSessions()

    expect(screen.getByRole('button', { name: `${FIRST} (working)` })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: `${SECOND} (working)` })).toBeInTheDocument()

    act(() => port.endTurn('s1'))

    expect(screen.getByRole('button', { name: FIRST })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: `${SECOND} (working)` })).toBeInTheDocument()
  })

  it('lights the workspace while any of its sessions works, and no longer', async () => {
    const port = await twoStreamingSessions()

    expect(screen.getByRole('button', { name: 'crucible (working)' })).toBeInTheDocument()

    act(() => {
      port.endTurn('s1')
      port.endTurn('s2')
    })

    expect(screen.getByRole('button', { name: 'crucible' })).toBeInTheDocument()
  })
})

describe('stopping one of them', () => {
  it('cancels only the active session, and leaves the other streaming', async () => {
    const port = await twoStreamingSessions()

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })

    expect(port.calls).toContainEqual({ op: 'cancel', args: ['s1'] })
    expect(port.calls).not.toContainEqual({ op: 'cancel', args: ['s2'] })
    expect(screen.getByText('Stopped')).toBeInTheDocument()

    await act(async () => activate(SECOND))
    expect(screen.queryByText('Stopped')).toBeNull()
    expect(screen.getByRole('button', { name: /Stop/ })).toBeInTheDocument()
  })
})
