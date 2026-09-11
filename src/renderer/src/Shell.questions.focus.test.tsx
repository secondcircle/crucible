// @vitest-environment jsdom
//
// The box takes the caret in exactly one case: answering or dismissing
// brought the next question. Arriving at a session is not that case, even
// though the question on show changes — the dock stays mounted across a
// switch, so it has to tell the two apart by session and not by question id
// alone. ⌘⇧A is how the user asks for the box.
import { act, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { Question, ShellSnapshot } from '../../shared/agent/port'
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
      createdAt: '2026-09-10T10:00:00.000Z',
      title: 'one',
      working: false,
      fresh: false
    },
    {
      id: 's2',
      workspaceId: 'w1',
      createdAt: '2026-09-10T10:01:00.000Z',
      title: 'two',
      working: false,
      fresh: false
    }
  ]
}

const questionOf = (id: string, question: string): Question => ({
  id,
  question,
  context: 'ctx',
  recommendation: 'rec',
  askedAt: new Date().toISOString()
})

it('keeps the caret where it was when a session switch brings another dock', async () => {
  const port = createScriptedPort(SNAPSHOT)
  render(
    <Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />
  )
  await act(settled)
  await act(async () => {
    port.askQuestion('s1', questionOf('q1', 'first session question?'))
    port.askQuestion('s2', questionOf('q2', 'second session question?'))
    port.askQuestion('s2', questionOf('q3', 'and one behind it?'))
    await settled()
  })

  const composer = screen.getByLabelText('Message')
  act(() => {
    composer.focus()
  })
  expect(document.activeElement).toBe(composer)

  await act(async () => {
    await port.activateSession('s2')
    await settled()
  })

  // Nothing was answered and nothing dismissed, so the box was not asked for.
  expect(screen.getByText('second session question?')).toBeTruthy()
  expect(document.activeElement).not.toBe(screen.getByLabelText('Your answer'))

  // And the switch did not cost the switched-to session the one focus it is
  // owed: dismissing brings the next question with its box focused.
  await act(async () => {
    screen.getByLabelText('Dismiss without answering').click()
    await settled()
  })

  expect(screen.getByText('and one behind it?')).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByLabelText('Your answer'))
})
