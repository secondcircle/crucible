// @vitest-environment jsdom
//
// Nothing may appear in the sidebar by discovery, and nothing may vanish from
// it because a conversation was deleted.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Shell } from './Shell'
import { createScriptedPort, oneSession, SESSION_TITLE, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { createScriptedCommands } from './testing/scripted-commands'
import { sessionRows, sessionsShown } from './testing/sidebar'
import { settled } from './testing/settled'

const MODEL = { id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off', 'low'] }

async function shellWithSession(): Promise<ScriptedPort> {
  const port = createScriptedPort(oneSession({ model: MODEL.id, thinkingLevel: 'low' }))
  port.models = [MODEL]
  render(<Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />)
  await sessionsShown()
  await settled()
  return port
}

const ops = (port: ScriptedPort): string[] => port.calls.map((call) => call.op)

describe('workspaces', () => {
  it('opens the folder picker, and changes nothing when it is cancelled', async () => {
    const port = createScriptedPort()
    render(<Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />)
    await screen.findByRole('button', { name: '＋ Add workspace' })
    port.folder = null

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '＋ Add workspace' }))
    })

    expect(ops(port)).toContain('addWorkspace')
    expect(screen.queryByRole('button', { name: 'crucible' })).toBeNull()
  })

  it('adds and activates the folder that was picked', async () => {
    const port = createScriptedPort()
    render(<Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />)
    await screen.findByRole('button', { name: '＋ Add workspace' })
    port.folder = '/repos/crucible'

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '＋ Add workspace' }))
    })

    expect(screen.getByRole('button', { name: 'crucible' })).toHaveAttribute(
      'aria-current',
      'true'
    )
  })

  it('offers Add workspace, and no usable composer, when there are none', async () => {
    const port = createScriptedPort()
    render(<Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />)
    await screen.findByRole('button', { name: 'Add workspace' })

    expect(screen.getByLabelText('Message')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('offers New session, and no usable composer, when a workspace has none', async () => {
    const port = createScriptedPort({
      workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
      activeWorkspaceId: 'w1',
      sessions: []
    })
    render(<Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />)
    await screen.findByRole('button', { name: 'crucible' })

    expect(screen.getByLabelText('Message')).toBeDisabled()
    const blank = screen.getByText('No session in this workspace.')
    expect(blank).toBeInTheDocument()
  })

  it('keeps every workspace listed, and lists the sessions of all of them', async () => {
    const port = createScriptedPort({
      workspaces: [
        { id: 'w1', name: 'crucible', path: '/repos/crucible' },
        { id: 'w2', name: 'pi-extensions', path: '/repos/pi-extensions' },
        { id: 'w3', name: 'empty', path: '/repos/empty' }
      ],
      activeWorkspaceId: 'w1',
      sessions: [
        {
          id: 's1',
          workspaceId: 'w1',
          createdAt: '2024-05-01T10:00:00.000Z',
          working: false,
          fresh: false
        },
        {
          id: 's2',
          workspaceId: 'w2',
          createdAt: '2024-05-01T11:00:00.000Z',
          working: true,
          title: SESSION_TITLE,
          fresh: false
        }
      ],
      activeSessionId: 's1'
    })
    render(<Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />)
    await screen.findByRole('button', { name: 'crucible' })

    expect(sessionRows()).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'empty' })).toBeInTheDocument()

    // The other workspace's session is still there after switching, working
    // dot and all, and one click on it is enough to open it.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'pi-extensions (working)' }))
    })

    expect(sessionRows()).toHaveLength(2)
    const working = screen.getByRole('button', { name: `${SESSION_TITLE} (working)` })
    await act(async () => {
      fireEvent.click(working)
    })

    expect(port.calls).toContainEqual({ op: 'activateSession', args: ['s2'] })
  })

  it('removes a workspace with its sessions, leaving the folder alone', async () => {
    const port = await shellWithSession()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove workspace crucible' }))
    })

    expect(port.calls).toContainEqual({ op: 'removeWorkspace', args: ['w1'] })
    expect(sessionRows()).toHaveLength(0)
  })
})

describe('sessions', () => {
  it('creates one in the active workspace and activates it', async () => {
    const port = await shellWithSession()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    })

    expect(port.calls).toContainEqual({ op: 'createSession', args: ['w1'] })
    expect(sessionRows()).toHaveLength(2)
    expect(sessionRows().at(-1)).toHaveAttribute('aria-current', 'true')
  })

  it('shows a neutral placeholder label and offers no way to rename it', async () => {
    await shellWithSession()

    expect(sessionRows()[0].textContent).toMatch(/^Wiring the composer/)
    expect(screen.queryByRole('button', { name: /rename/i })).toBeNull()
    expect(screen.queryByRole('textbox', { name: /name/i })).toBeNull()
  })

  it('forgets a removed session', async () => {
    const port = await shellWithSession()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Remove Wiring the composer/ }))
    })

    expect(port.calls).toContainEqual({ op: 'removeSession', args: ['s1'] })
    expect(sessionRows()).toHaveLength(0)
  })

  it('shows a minimal empty state for a session with nothing in it', async () => {
    await shellWithSession()

    expect(screen.getByText('This session is empty.')).toBeInTheDocument()
  })

  it('restores settled history when a session is opened for the first time', async () => {
    const port = createScriptedPort(oneSession())
    port.transcripts.set('s1', [
      { kind: 'user', text: 'what did we decide?' },
      { kind: 'assistant', markdown: 'That the sidebar is **curated**.' },
      { kind: 'stopped' }
    ])
    render(<Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />)

    expect(await screen.findByText('what did we decide?')).toBeInTheDocument()
    expect(screen.getByText('curated').tagName).toBe('STRONG')
    expect(screen.getByText('Stopped')).toBeInTheDocument()
  })
})

describe('reset', () => {
  it('lives in the session header menu', async () => {
    await shellWithSession()

    fireEvent.click(screen.getByRole('button', { name: 'Session menu' }))

    expect(screen.getByRole('menuitem', { name: 'Reset session' })).toBeInTheDocument()
  })

  it('asks first when the session has a conversation, and honors keeping it', async () => {
    const port = await shellWithSession()
    const box = screen.getByLabelText('Message')
    fireEvent.change(box, { target: { value: 'something said' } })
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' })
    })
    act(() => port.endTurn('s1'))

    fireEvent.click(screen.getByRole('button', { name: 'Session menu' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Reset session' }))
    })

    expect(screen.getByRole('dialog', { name: /Reset this session/ })).toBeInTheDocument()
    expect(ops(port)).not.toContain('resetSession')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep the conversation' }))
    })

    expect(ops(port)).not.toContain('resetSession')
    expect(screen.getByText('something said')).toBeInTheDocument()
  })

  it('keeps the sidebar entry and empties the conversation when it is confirmed', async () => {
    const port = await shellWithSession()
    const box = screen.getByLabelText('Message')
    fireEvent.change(box, { target: { value: 'something said' } })
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' })
    })
    act(() => port.endTurn('s1'))

    fireEvent.click(screen.getByRole('button', { name: 'Session menu' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Reset session' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reset anyway' }))
    })

    expect(port.calls).toContainEqual({ op: 'resetSession', args: ['s1'] })
    expect(sessionRows()).toHaveLength(1)
    expect(screen.queryByText('something said')).toBeNull()
    expect(screen.getByText('This session is empty.')).toBeInTheDocument()
  })

  it('asks nothing of an empty session', async () => {
    const port = await shellWithSession()

    fireEvent.click(screen.getByRole('button', { name: 'Session menu' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Reset session' }))
    })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(port.calls).toContainEqual({ op: 'resetSession', args: ['s1'] })
  })
})

describe('resume', () => {
  async function openOverlay(): Promise<ScriptedPort> {
    const port = await shellWithSession()
    port.history = [
      { ref: 'ref-1', preview: 'you: how does the agent port work?', at: '2026-08-19T13:00:00Z' },
      { ref: 'ref-2', preview: 'you: draft the Ember palette', at: '2026-08-18T09:00:00Z' }
    ]
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resume session…' }))
    })
    return port
  }

  it('searches the active workspace only while the overlay is open', async () => {
    const port = await openOverlay()

    const overlay = screen.getByRole('dialog', { name: 'Resume session' })
    expect(port.calls).toContainEqual({ op: 'searchHistory', args: ['w1', ''] })
    expect(within(overlay).getAllByRole('button')).toHaveLength(2)

    await act(async () => {
      fireEvent.change(within(overlay).getByLabelText('Search conversations'), {
        target: { value: 'palette' }
      })
    })

    expect(port.calls).toContainEqual({ op: 'searchHistory', args: ['w1', 'palette'] })
    expect(within(overlay).getAllByRole('button')).toHaveLength(1)
  })

  it('shows a display-safe preview and a relative time, and no storage detail', async () => {
    await openOverlay()

    const overlay = screen.getByRole('dialog', { name: 'Resume session' })
    expect(overlay.textContent).toContain('how does the agent port work?')
    expect(overlay.textContent).not.toContain('ref-1')
    expect(overlay.textContent).not.toContain('.jsonl')
  })

  it('adds the chosen conversation to the sidebar and activates it', async () => {
    const port = await openOverlay()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /how does the agent port work/ }))
    })

    expect(port.calls).toContainEqual({ op: 'resumeSession', args: ['w1', 'ref-1'] })
    expect(screen.queryByRole('dialog', { name: 'Resume session' })).toBeNull()
    expect(sessionRows()).toHaveLength(2)
    expect(sessionRows().at(-1)).toHaveAttribute('aria-current', 'true')
  })

  it('closes on Escape without touching any work', async () => {
    const port = await openOverlay()
    await act(async () => {
      await port.prompt('s1', 'still running')
    })

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })

    expect(screen.queryByRole('dialog', { name: 'Resume session' })).toBeNull()
    expect(ops(port)).not.toContain('cancel')
  })
})

describe('what the top bar says', () => {
  // Everything left of the Tree button was a second copy of something already
  // on screen, so the bar says none of it.
  it('repeats nothing the sidebar or the composer chip already says', async () => {
    await shellWithSession()

    const header = screen.getByRole('banner')
    expect(header.textContent).not.toContain('Wiring the composer')
    expect(header.textContent).not.toContain('crucible')
    expect(header.textContent).not.toContain('Fake')
    expect(within(header).queryByLabelText('Agent working')).toBeNull()
  })

  it('starts at the Tree button and keeps the right-hand cluster', async () => {
    await shellWithSession()

    const header = screen.getByRole('banner')
    const controls = within(header).getAllByRole('button').map((button) => button.getAttribute('aria-label'))
    expect(controls[0]).toBe('Session tree')
    expect(controls).toEqual(['Session tree', 'Session cost', 'Settings', 'Session menu'])
  })

  it('keeps the same shape with no session at all', async () => {
    const port = await shellWithSession()

    await act(async () => {
      await port.removeSession('s1')
    })

    const header = screen.getByRole('banner')
    expect(
      within(header).getAllByRole('button').map((button) => button.getAttribute('aria-label'))
    ).toEqual(['Settings'])
    expect(header.textContent).not.toContain('No session')
  })

  it('leaves the working state to the sidebar row', async () => {
    const port = await shellWithSession()

    await act(async () => {
      await port.prompt('s1', 'go')
    })

    expect(screen.queryByLabelText('Agent working')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Wiring the composer to the agent port (working)' })
    ).toBeInTheDocument()
  })
})
