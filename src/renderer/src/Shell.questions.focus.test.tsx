// @vitest-environment jsdom
//
// Left failing by review-1: switching sessions yanks the caret into the new
// session's answer box. The intent document gives the box focus only when
// answering or dismissing brings the next question — and the dock's own
// comment says the first question shown must not take the caret, ⌘⇧A being
// how the user asks for it. The dock's focus effect keys on `question.id`
// changing, which a session switch also does whenever both sessions hold open
// questions, so arriving at a session steals the caret out of the composer.
import { act, fireEvent, render, screen } from '@testing-library/react'
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
  expect(document.activeElement).not.toBe(screen.getByLabelText('Your answer'))
})
