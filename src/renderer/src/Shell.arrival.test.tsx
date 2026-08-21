// @vitest-environment jsdom
//
// Arriving at a session means seeing that session: its transcript, its
// composer, and nothing left over from anywhere else. Every surface that
// covers or crowds the chat goes in the frame the click lands, whichever way
// the user arrived.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ProviderState, ShellSnapshot } from '../../shared/agent/port'
import { createFakeCacheService, fakeCacheHealth } from '../../shared/cache/fake-service'
import type { RunRecord } from '../../shared/workflows/run'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkflowRuns } from './testing/scripted-workflow-runs'
import { createScriptedWorkspace, type ScriptedWorkspace } from './testing/scripted-workspace'
import { hostedBoard } from './testing/boards'
import { hostedIssues } from './testing/issues'
import { sessionRows, sessionsShown } from './testing/sidebar'
import { settled } from './testing/settled'

const NOW = '2026-08-21T14:14:00.000Z'

const TWO_SESSIONS: ShellSnapshot = {
  workspaces: [
    { id: 'w1', name: 'crucible', path: '/repos/crucible' },
    { id: 'w2', name: 'resume-site', path: '/repos/resume-site' }
  ],
  activeWorkspaceId: 'w1',
  sessions: [
    {
      id: 's1',
      workspaceId: 'w1',
      createdAt: NOW,
      title: 'wiring the composer',
      working: false,
      fresh: false
    },
    {
      id: 's2',
      workspaceId: 'w1',
      createdAt: NOW,
      title: 'quota strip polish',
      working: false,
      fresh: false
    },
    {
      id: 's3',
      workspaceId: 'w2',
      createdAt: NOW,
      title: 'og image pipeline',
      working: false,
      fresh: false
    }
  ],
  activeSessionId: 's1'
}

const PROVIDERS: readonly ProviderState[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    methods: ['oauth', 'api-key'],
    status: { kind: 'none' }
  }
]

const RUN: RunRecord = {
  id: 'en42',
  workflow: 'build',
  status: 'running',
  workspacePath: '/repos/crucible',
  workspaceName: 'crucible',
  sessionId: 's1',
  inputs: {},
  nodes: [{ id: 'builder', status: 'running', parents: [], reads: [], artifacts: [] }],
  createdAt: NOW,
  startedAt: NOW
}

async function shell(): Promise<{ port: ScriptedPort; workspace: ScriptedWorkspace }> {
  const port = createScriptedPort(TWO_SESSIONS)
  port.models = [{ id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off', 'low'] }]
  port.providers = PROVIDERS
  port.trees.set('s1', {
    roots: [{ ref: 'n1', text: 'Scaffold the overlay.', at: NOW, children: [] }],
    path: ['n1']
  })
  port.transcripts.set('s1', [{ kind: 'assistant', markdown: 'the first session speaking' }])
  const workspace = createScriptedWorkspace()
  workspace.boards.set('/repos/crucible', { kind: 'board', board: hostedBoard() })
  workspace.issues.set('/repos/crucible', { kind: 'board', board: hostedIssues() })
  workspace.files = ['src/renderer/src/Shell.tsx']
  render(
    <Shell
      port={port}
      workspace={workspace}
      commands={createScriptedCommands()}
      cache={createFakeCacheService(fakeCacheHealth({ count: 3, dollars: 1.2, since: NOW }))}
      workflowRuns={createScriptedWorkflowRuns([RUN])}
    />
  )
  await sessionsShown()
  await settled()
  return { port, workspace }
}

async function click(name: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

async function type(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: text, selectionStart: text.length }
    })
  })
}

/** A click on the other session in the rail: the plainest arrival there is. */
async function switchSession(): Promise<void> {
  await act(async () => {
    fireEvent.click(sessionRows()[1] as HTMLElement)
  })
  await settled()
}

const composer = (): HTMLElement => screen.getByLabelText('Message')

describe('what an arrival closes', () => {
  it('takes the session tree overlay off', async () => {
    await shell()
    await click('Session tree')
    expect(screen.queryByRole('dialog', { name: 'Session tree' })).not.toBeNull()

    await switchSession()

    expect(screen.queryByRole('dialog', { name: 'Session tree' })).toBeNull()
  })

  it('takes the branch board and the issue board off', async () => {
    await shell()
    await click('Branch board')
    expect(screen.queryByRole('dialog', { name: 'Branch board' })).not.toBeNull()

    await switchSession()
    expect(screen.queryByRole('dialog', { name: 'Branch board' })).toBeNull()

    await click('Issue board')
    expect(screen.queryByRole('dialog', { name: 'Issue board' })).not.toBeNull()

    await switchSession()
    expect(screen.queryByRole('dialog', { name: 'Issue board' })).toBeNull()
  })

  it('takes the runs overview and an opened run off', async () => {
    await shell()
    await act(async () => {
      fireEvent.keyDown(document, { key: 'r', metaKey: true })
    })
    await click('Open run')
    expect(screen.queryByLabelText('Run en42')).not.toBeNull()

    await switchSession()

    expect(screen.queryByLabelText('Run en42')).toBeNull()
    expect(screen.queryByLabelText('All runs')).toBeNull()
  })

  it('takes the Settings sheet off', async () => {
    await shell()
    await click('Settings')
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeNull()

    await switchSession()

    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
  })

  it('takes the cache health view off', async () => {
    await shell()
    await click(/cache/i)
    expect(screen.queryByRole('dialog', { name: 'Cache health' })).not.toBeNull()

    await switchSession()

    expect(screen.queryByRole('dialog', { name: 'Cache health' })).toBeNull()
  })

  it('takes every popover off', async () => {
    await shell()
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/^Model:/))
    })
    expect(screen.queryByRole('dialog', { name: 'Model picker' })).not.toBeNull()

    await switchSession()
    expect(screen.queryByRole('dialog', { name: 'Model picker' })).toBeNull()

    await click('Session menu')
    expect(screen.queryByRole('menuitem', { name: 'Reset session' })).not.toBeNull()

    await switchSession()
    expect(screen.queryByRole('menuitem', { name: 'Reset session' })).toBeNull()

    await click('Resume session…')
    expect(screen.queryByRole('dialog', { name: 'Resume session' })).not.toBeNull()

    await switchSession()
    expect(screen.queryByRole('dialog', { name: 'Resume session' })).toBeNull()
  })

  it("takes the composer's own command and file popovers off", async () => {
    await shell()
    await type('/')
    await settled()
    expect(screen.queryByRole('listbox', { name: 'Commands' })).not.toBeNull()

    await switchSession()
    expect(screen.queryByRole('listbox', { name: 'Commands' })).toBeNull()

    await type('@Shell')
    await settled()
    expect(screen.queryByRole('listbox', { name: 'Files in this workspace' })).not.toBeNull()

    await switchSession()
    expect(screen.queryByRole('listbox', { name: 'Files in this workspace' })).toBeNull()
  })

  it('takes a confirm dialog off', async () => {
    await shell()
    await click('Session menu')
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Reset session' }))
    })
    expect(screen.queryByRole('dialog', { name: 'Reset this session?' })).not.toBeNull()

    await switchSession()

    expect(screen.queryByRole('dialog', { name: 'Reset this session?' })).toBeNull()
  })

  // The one exemption: credentials are global, the flow is modal, and it is
  // not session state — so the sheet holding it stays too.
  it('leaves a live login dialog exactly where it is', async () => {
    await shell()
    await click('Settings')
    await click('Add provider')
    await click(/OpenRouter/)
    await click('Use an API key')
    expect(screen.queryByRole('dialog', { name: 'Log in to OpenRouter' })).not.toBeNull()

    await switchSession()

    expect(screen.queryByRole('dialog', { name: 'Log in to OpenRouter' })).not.toBeNull()
  })
})

describe('the ways a session is arrived at', () => {
  it('is a click in the rail, and the session on screen is one of them', async () => {
    const { port } = await shell()
    await click('Session tree')

    // The already-active session: arriving is arriving, whoever was there.
    await act(async () => {
      fireEvent.click(sessionRows()[0] as HTMLElement)
    })

    expect(screen.queryByRole('dialog', { name: 'Session tree' })).toBeNull()
    expect(port.calls).toContainEqual({ op: 'activateSession', args: ['s1'] })
  })

  it('is New session, which lands on the empty composer of the new one', async () => {
    await shell()
    await click('Session tree')
    await type('half a sentence')

    await click('New session')
    await settled()

    expect(screen.queryByRole('dialog', { name: 'Session tree' })).toBeNull()
    // The new session's own composer: no draft, and nothing of the old
    // transcript.
    expect(composer()).toHaveValue('')
    expect(screen.queryByText('the first session speaking')).toBeNull()
  })

  // Tab is claimed only where no surface is up, so what it has to wipe is the
  // banner the session being left had on screen.
  it('is the Tab walk', async () => {
    const { port } = await shell()
    port.jumpRefusal = 'That session is working. Stop it first.'
    await click('Session tree')
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('dialog', { name: 'Session tree' }), {
        key: 'ArrowDown'
      })
    })
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('dialog', { name: 'Session tree' }), { key: 'Enter' })
    })
    await settled()
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Stop it first')

    // A turn that ended while another session was on screen is what the walk
    // goes to.
    await act(async () => {
      void port.prompt('s2', 'go')
    })
    await act(async () => {
      port.endTurn('s2')
    })
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Tab' })
    })
    await settled()

    expect(port.calls).toContainEqual({ op: 'activateSession', args: ['s2'] })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('is Go to session from a run surface', async () => {
    await shell()
    await act(async () => {
      fireEvent.keyDown(document, { key: 'r', metaKey: true })
    })

    await click('Go to session')
    await settled()

    expect(screen.queryByLabelText('All runs')).toBeNull()
  })

  it('is activating a workspace, which lands on a session of its own', async () => {
    const { port } = await shell()
    await click('Session tree')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'resume-site' }))
    })
    await settled()

    expect(screen.queryByRole('dialog', { name: 'Session tree' })).toBeNull()
    expect(port.snapshotNow.activeSessionId).toBe('s3')
  })

  it('is the removal of the session on screen, which lands on the next one', async () => {
    const { port } = await shell()
    await click('Session tree')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove wiring the composer' }))
    })
    await settled()

    expect(screen.queryByRole('dialog', { name: 'Session tree' })).toBeNull()
    expect(port.snapshotNow.activeSessionId).not.toBe('s1')
  })
})
