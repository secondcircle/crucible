// @vitest-environment jsdom
//
// The instance badge: which state directory this window runs against, named in
// the top bar so two dev windows can never look identical. The value arrives
// as a prop, exactly as main hands it to the window at creation.
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { settled } from './testing/settled'

const SNAPSHOT: ShellSnapshot = {
  workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
  activeWorkspaceId: 'w1',
  activeSessionId: 's1',
  sessions: [
    {
      id: 's1',
      workspaceId: 'w1',
      createdAt: '2026-08-26T10:00:00.000Z',
      title: 'run-state honesty',
      working: false,
      fresh: false
    }
  ]
}

async function mount(instance?: string): Promise<void> {
  render(
    <Shell
      port={createScriptedPort(SNAPSHOT)}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
      {...(instance === undefined ? {} : { instance })}
    />
  )
  await act(settled)
}

const badge = (): HTMLElement | null => document.querySelector('.top .instance')

describe('the instance badge', () => {
  it('names the plain dev state in a primary clone', async () => {
    await mount('dev')
    expect(badge()?.textContent).toBe('dev')
    // A mark, not a control: it is in the bar and opens nothing.
    expect(badge()?.tagName).toBe('SPAN')
    expect(screen.getByLabelText('Instance dev')).toBeTruthy()
  })

  it('names the state directory’s own suffix in a worktree launch', async () => {
    await mount('dev · 4aa56f')
    expect(badge()?.textContent).toBe('dev · 4aa56f')
  })

  it('is absent entirely when the bridge names no instance', async () => {
    await mount()
    expect(badge()).toBeNull()
  })
})
