// @vitest-environment jsdom
//
// Crucible on a machine that is not a Mac: every ⌘ becomes Ctrl and every ⌥
// becomes Alt, in what the app answers to and in every hint it prints. The
// platform is the one fact these tests change; everything else is the app as
// it ships.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import type { RunRecord } from '../../shared/workflows/run'
import { Shell } from './Shell'
import { runningOn } from './keys'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkflowRuns } from './testing/scripted-workflow-runs'
import { createScriptedWorkspace, type ScriptedWorkspace } from './testing/scripted-workspace'
import { hostedBoard } from './testing/boards'
import { hostedIssues } from './testing/issues'
import { sessionsShown } from './testing/sidebar'
import { settled } from './testing/settled'

const LIVE_RUN: RunRecord = {
  id: 'en42',
  workflow: 'build',
  status: 'running',
  workspacePath: '/repos/crucible',
  workspaceName: 'crucible',
  sessionId: 's1',
  inputs: {},
  nodes: [{ id: 'builder', status: 'running', parents: [], reads: [], artifacts: [] }],
  createdAt: '2026-08-20T10:00:00.000Z',
  startedAt: '2026-08-20T10:00:00.000Z'
}

async function shell(
  snapshot: Partial<ShellSnapshot> = oneSession({ model: 'fake/deterministic' })
): Promise<{ port: ScriptedPort; workspace: ScriptedWorkspace }> {
  const port = createScriptedPort(snapshot)
  port.models = [{ id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off', 'low'] }]
  const workspace = createScriptedWorkspace()
  workspace.boards.set('/repos/crucible', { kind: 'board', board: hostedBoard() })
  workspace.issues.set('/repos/crucible', { kind: 'board', board: hostedIssues() })
  render(
    <Shell
      port={port}
      workspace={workspace}
      commands={createScriptedCommands()}
      workflowRuns={createScriptedWorkflowRuns([LIVE_RUN])}
    />
  )
  await sessionsShown()
  await settled()
  return { port, workspace }
}

async function press(key: string, modifiers: Record<string, boolean> = {}): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(document, { key, ...modifiers })
  })
}

const said = (): string => document.body.textContent ?? ''

describe('a Windows or Linux launch', () => {
  it('spells every hint with the keys that machine has', async () => {
    runningOn('win32')
    const { port } = await shell()

    // The composer's placeholder, before anything is typed.
    expect(screen.getByLabelText('Message')).toHaveAttribute(
      'placeholder',
      expect.stringContaining('Ctrl+V pastes an image')
    )
    // The run strip, which is up because this session has a live run.
    expect(document.querySelector('.rshint')).toHaveTextContent('Ctrl+R all runs')

    await act(async () => {
      await port.prompt('s1', 'go')
    })

    // The composer footer, while the session works.
    expect(document.querySelector('.esc')).toHaveTextContent('⏎ steer · Alt+⏎ follow-up · esc stop')

    // The queued strip's edit hint.
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'and check the tests' } })
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' })
    })
    expect(document.querySelector('.qhint')).toHaveTextContent('queued · click or Alt+↑ to edit')
  })

  it('spells the branch board’s footer the same way, and opens it on Ctrl+B', async () => {
    runningOn('linux')
    await shell()

    // The Mac chord is not this platform's chord, and does nothing here.
    await press('b', { metaKey: true })
    expect(screen.queryByRole('dialog', { name: 'Branch board' })).toBeNull()

    await press('b', { ctrlKey: true })

    expect(screen.queryByRole('dialog', { name: 'Branch board' })).not.toBeNull()
    expect(said()).toContain('Ctrl+B close')
    expect(said()).toContain('Ctrl+C copy branch name')
  })

  it('spells the issue board’s footer the same way, and opens it on Ctrl+I', async () => {
    runningOn('win32')
    await shell()

    await press('i', { ctrlKey: true })
    await settled()

    expect(screen.queryByRole('dialog', { name: 'Issue board' })).not.toBeNull()
    expect(said()).toContain('Ctrl+I close')
    expect(said()).toContain('Ctrl+⏎ open on GitHub')
    expect(said()).toContain('Ctrl+C copy crucible#128')
    // The button in the reading pane names the same chord as the footer.
    expect(said()).toContain('Open on GitHub Ctrl+⏎')
  })
})

describe('a Mac launch', () => {
  it('keeps the glyphs, and answers to ⌘ alone', async () => {
    // Declared, not defaulted: this is the platform every other test runs as.
    runningOn('darwin')
    await shell()

    expect(document.querySelector('.rshint')).toHaveTextContent('⌘R all runs')

    // Not a Mac chord: no Mac app treats Ctrl+B as one.
    await press('b', { ctrlKey: true })
    expect(screen.queryByRole('dialog', { name: 'Branch board' })).toBeNull()

    await press('b', { metaKey: true })

    expect(screen.queryByRole('dialog', { name: 'Branch board' })).not.toBeNull()
    expect(said()).toContain('⌘B close')
  })
})
