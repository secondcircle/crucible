// @vitest-environment jsdom
//
// A bash run is local until the user says otherwise: the model sees nothing of
// it, and the agent port hears nothing of it, unless it is added.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import { Shell } from './Shell'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace, type ScriptedWorkspace } from './testing/scripted-workspace'
import { createScriptedCommands } from './testing/scripted-commands'
import { sessionsShown } from './testing/sidebar'
import { settled } from './testing/settled'

const TWO_WORKSPACES: ShellSnapshot = {
  workspaces: [
    { id: 'w1', name: 'crucible', path: '/repos/crucible' },
    { id: 'w2', name: 'pi-extensions', path: '/repos/pi-extensions' }
  ],
  activeWorkspaceId: 'w1',
  sessions: [
    { id: 's1', workspaceId: 'w1', createdAt: '2026-08-19T14:14:00.000Z', working: false, fresh: false },
    { id: 's2', workspaceId: 'w2', createdAt: '2026-08-19T15:20:00.000Z', working: false, fresh: false }
  ],
  activeSessionId: 's1'
}

const TWO_IN_ONE_WORKSPACE: ShellSnapshot = {
  workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
  activeWorkspaceId: 'w1',
  sessions: [
    {
      id: 's1',
      workspaceId: 'w1',
      title: 'tailing the log',
      createdAt: '2026-08-19T14:14:00.000Z',
      working: false,
      fresh: false
    },
    {
      id: 's2',
      workspaceId: 'w1',
      title: 'reading the spec',
      createdAt: '2026-08-19T15:20:00.000Z',
      working: false,
      fresh: false
    }
  ],
  activeSessionId: 's1'
}

async function shell(
  snapshot: Partial<ShellSnapshot> = oneSession()
): Promise<{ port: ScriptedPort; workspace: ScriptedWorkspace }> {
  const port = createScriptedPort(snapshot)
  port.models = [{ id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off'] }]
  const workspace = createScriptedWorkspace()
  render(<Shell port={port} workspace={workspace} commands={createScriptedCommands()} />)
  await sessionsShown()
  await settled()
  return { port, workspace }
}

const box = (): HTMLElement => screen.getByLabelText('Message')

async function type(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(box(), { target: { value: text, selectionStart: text.length } })
  })
}

async function enter(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(box(), { key: 'Enter' })
  })
}

const drawer = (): HTMLElement | null =>
  document.querySelector('.drawer') as HTMLElement | null

const output = (): string => document.querySelector('.drawerout')?.textContent ?? ''

async function run(command: string, workspace: ScriptedWorkspace): Promise<void> {
  await type(`!${command}`)
  await enter()
  await act(async () => {
    await Promise.resolve()
  })
  expect(workspace.started.at(-1)?.command).toBe(command)
}

describe('bash mode', () => {
  it('flips the composer on a leading bang and says what enter will do', async () => {
    await shell()

    await type('!git status')

    expect(document.querySelector('.cbox.bash')).not.toBeNull()
    expect(screen.getByText(/runs locally in the workspace/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run ⏎' })).toBeEnabled()
    expect(screen.getByText(/· \/repos\/crucible/)).toBeInTheDocument()
  })

  it('treats any number of bangs as the same grammar', async () => {
    const { workspace } = await shell()

    await type('!!  git status')
    await enter()

    expect(workspace.started.at(-1)?.command).toBe('git status')
  })

  it('runs nothing for bangs alone', async () => {
    const { workspace } = await shell()

    await type('!!')

    expect(screen.getByRole('button', { name: 'Run ⏎' })).toBeDisabled()
    await enter()
    expect(workspace.started).toHaveLength(0)
  })

  it('goes back to a normal composer when the bang is deleted', async () => {
    await shell()
    await type('!git status')

    await type('git status')

    expect(document.querySelector('.cbox.bash')).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
  })

})

describe('the drawer', () => {
  it('streams the run and shows how it ended', async () => {
    const { port, workspace } = await shell()

    await run('git status', workspace)
    expect(box()).toHaveValue('')
    expect(drawer()).not.toBeNull()

    await act(async () => {
      workspace.output(workspace.lastRun(), 'On branch crucible/ember-shell\n')
      workspace.output(workspace.lastRun(), 'nothing to commit\n')
    })
    expect(output()).toBe('On branch crucible/ember-shell\nnothing to commit\n')

    await act(async () => {
      workspace.end(workspace.lastRun(), 0)
    })
    expect(screen.getByText('exit 0')).toBeInTheDocument()

    // Local by default: the transcript and the port are untouched.
    expect(screen.queryByLabelText(/^Shared bash run/)).toBeNull()
    expect(port.calls.map((call) => call.op)).not.toContain('shareBashRun')
  })

  it('marks a failing run with its own exit status', async () => {
    const { workspace } = await shell()
    await run('npm run dploy', workspace)

    await act(async () => {
      workspace.end(workspace.lastRun(), 1)
    })

    expect(screen.getByText('exit 1')).toBeInTheDocument()
  })

  it('stops a long run through the workspace service and says it was stopped', async () => {
    const { workspace } = await shell()
    await run('tail -f log', workspace)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    })
    expect(workspace.calls).toContainEqual({ op: 'stopRun', args: [workspace.lastRun()] })

    await act(async () => {
      workspace.end(workspace.lastRun())
    })
    expect(screen.getByText('stopped')).toBeInTheDocument()
  })

  it('offers no Close while the run is going, and closes once it is over', async () => {
    const { workspace } = await shell()
    await run('tail -f log', workspace)

    expect(screen.queryByRole('button', { name: 'Close ×' })).toBeNull()

    await act(async () => {
      workspace.end(workspace.lastRun(), 0)
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close ×' }))
    })

    expect(drawer()).toBeNull()
  })

  it('refuses a second run while one is live, and points at Stop', async () => {
    const { workspace } = await shell()
    await run('tail -f log', workspace)

    await type('!git status')
    await enter()

    expect(workspace.started).toHaveLength(1)
    expect(screen.getByText(/already running here/)).toBeInTheDocument()
  })

  // Arriving at a session means seeing that session. The drawer belongs to the
  // session that started the command, so arriving elsewhere takes it off screen
  // by showing the session you arrived at — not by killing anything.
  it('keeps the run with its session when the workspace changes', async () => {
    const { port, workspace } = await shell(TWO_WORKSPACES)
    await run('tail -f log', workspace)

    await act(async () => {
      await port.activateWorkspace('w2')
    })
    expect(drawer()).toBeNull()

    // Switching away stops nothing: the run is still going, and comes back
    // with its session.
    await act(async () => {
      workspace.output(workspace.lastRun(), 'still running\n')
      await port.activateWorkspace('w1')
    })
    expect(output()).toBe('still running\n')
    expect(workspace.calls.map((call) => call.op)).not.toContain('stopRun')
  })

  // The defect this keying fixes: two sessions in one workspace used to share
  // a single drawer, so arriving at the second one still showed the first
  // one's command.
  it('does not show one session\u2019s drawer to another in the same workspace', async () => {
    const { port, workspace } = await shell(TWO_IN_ONE_WORKSPACE)
    await run('tail -f log', workspace)

    await act(async () => {
      await port.activateSession('s2')
    })
    expect(drawer()).toBeNull()
    expect(workspace.calls.map((call) => call.op)).not.toContain('stopRun')

    await act(async () => {
      workspace.output(workspace.lastRun(), 'still running\n')
      await port.activateSession('s1')
    })
    expect(output()).toBe('still running\n')
  })

  // The one moment a command is stopped for the user: its session is being
  // deleted, so there is nowhere left to come back to it from.
  it('stops the run when the session that owns it is removed', async () => {
    const { workspace } = await shell(TWO_IN_ONE_WORKSPACE)
    await run('tail -f log', workspace)
    const started = workspace.lastRun()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove tailing the log' }))
    })

    expect(workspace.calls).toContainEqual({ op: 'stopRun', args: [started] })
  })
})

describe('running while the agent works', () => {
  it('runs the command and leaves the agent Stop where it was', async () => {
    const { workspace } = await shell()
    await type('write the adapter')
    await enter()

    await run('git status', workspace)

    // The agent's own Stop, untouched, beside the drawer's Stop for the run.
    expect(document.querySelector('.crow .stop')).not.toBeNull()
    expect(drawer()).not.toBeNull()
  })
})

describe('add to conversation', () => {
  async function finished(): Promise<{ port: ScriptedPort; workspace: ScriptedWorkspace }> {
    const both = await shell()
    await run('git status', both.workspace)
    await act(async () => {
      both.workspace.output(both.workspace.lastRun(), 'nothing to commit\n')
      both.workspace.end(both.workspace.lastRun(), 0)
    })
    return both
  }

  it('is the only way a run reaches the model', async () => {
    const { port } = await finished()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add to conversation' }))
    })

    expect(port.calls).toContainEqual({
      op: 'shareBashRun',
      args: ['s1', { command: 'git status', output: 'nothing to commit\n', exitCode: 0 }]
    })
  })

  it('waits while a live turn has it, then closes on the delivery', async () => {
    const { port } = await finished()
    port.holdShare = true

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add to conversation' }))
    })
    expect(screen.getByRole('button', { name: 'Add to conversation' })).toBeDisabled()
    expect(screen.getByText('queued for the model…')).toBeInTheDocument()

    await act(async () => {
      // The row appears where the port says it was delivered, and the drawer
      // is done with it.
      port.bashRunShared('s1', { command: 'git status', output: 'nothing to commit\n', exitCode: 0 })
      port.settleShare('delivered')
      await Promise.resolve()
    })

    expect(drawer()).toBeNull()
    const row = screen.getByLabelText('Shared bash run: git status')
    expect(row).toHaveTextContent('shared with model')
    expect(row).toHaveTextContent('nothing to commit')
  })

  it('comes back to the Add state when the turn stopped first', async () => {
    const { port } = await finished()
    port.shareOutcome = 'dropped'

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add to conversation' }))
      await Promise.resolve()
    })

    expect(screen.getByRole('button', { name: 'Add to conversation' })).toBeEnabled()
    expect(screen.getByText(/still local/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/^Shared bash run/)).toBeNull()
  })

  it('shows a shared run in a restored transcript exactly the same way', async () => {
    const port = createScriptedPort(oneSession())
    port.transcripts.set('s1', [
      { kind: 'bashRun', command: 'git status', output: 'clean\n', exitCode: 0 }
    ])
    render(<Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />)

    const row = await screen.findByLabelText('Shared bash run: git status')
    expect(row).toHaveTextContent('shared with model')
  })
})
