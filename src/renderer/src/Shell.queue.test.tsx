// @vitest-environment jsdom
//
// What a person can send while the agent is working, and what happens to it:
// nothing queued may show up in the transcript, and nothing queued may be lost
// on the way back to the composer.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import { sessionLabel } from './labels'
import { Shell } from './Shell'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'

const TWO_SESSIONS: ShellSnapshot = {
  workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
  activeWorkspaceId: 'w1',
  sessions: [
    { id: 's1', workspaceId: 'w1', createdAt: '2026-08-19T14:14:00.000Z', working: false },
    { id: 's2', workspaceId: 'w1', createdAt: '2026-08-19T15:20:00.000Z', working: false }
  ],
  activeSessionId: 's1'
}

async function shellWithSession(
  snapshot: Partial<ShellSnapshot> = oneSession()
): Promise<ScriptedPort> {
  const port = createScriptedPort(snapshot)
  port.models = [{ id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off', 'low'] }]
  render(<Shell port={port} />)
  await screen.findAllByRole('button', { name: /^Session · / })
  return port
}

const box = (): HTMLElement => screen.getByLabelText('Message')

function type(text: string): void {
  fireEvent.change(box(), { target: { value: text } })
}

async function press(key: string, modifiers: Record<string, boolean> = {}): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(box(), { key, ...modifiers })
  })
}

/** Sent the way a person sends it, so the transcript has something in it. */
async function working(): Promise<void> {
  type('write the adapter')
  await press('Enter')
}

const ops = (port: ScriptedPort): string[] => port.calls.map((call) => call.op)

const strip = (): HTMLElement | null => screen.queryByLabelText('Queued messages')

const entries = (): string[] =>
  Array.from(strip()?.querySelectorAll('.qitem') ?? []).map((item) => item.textContent ?? '')

describe('the composer while a session works', () => {
  it('offers Steer beside Stop, and the key map the mock spells out', async () => {
    await shellWithSession()

    await working()

    expect(screen.getByRole('button', { name: 'Steer ⏎' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Stop/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    const hint = screen.getByText(/agent working/).parentElement
    expect(hint).toHaveTextContent('⏎ steer · ⌥⏎ follow-up · esc stop · ⇧⏎ newline')
  })

  it('leaves Steer unavailable for a draft with nothing in it', async () => {
    await shellWithSession()
    await working()

    expect(screen.getByRole('button', { name: 'Steer ⏎' })).toBeDisabled()

    type('and check the tests')

    expect(screen.getByRole('button', { name: 'Steer ⏎' })).toBeEnabled()
  })
})

describe('queueing', () => {
  it('makes Enter a steering message, and shows it only in the strip', async () => {
    const port = await shellWithSession()
    await working()

    type('check the adapter too')
    await press('Enter')

    expect(port.calls).toContainEqual({ op: 'steer', args: ['s1', 'check the adapter too'] })
    expect(port.calls.filter((call) => call.op === 'prompt')).toHaveLength(1)
    // Undelivered, so the transcript says nothing about it.
    expect(
      screen.getByRole('log', { name: 'Transcript' })
    ).not.toHaveTextContent('check the adapter too')
    expect(entries()).toEqual(['steercheck the adapter tooqueued · click or ⌥↑ to edit'])
    expect(box()).toHaveValue('')
  })

  it('makes Option+Enter a follow-up, badged as one', async () => {
    const port = await shellWithSession()
    await working()

    type('then summarize what you would refactor')
    await press('Enter', { altKey: true })

    expect(port.calls).toContainEqual({
      op: 'followUp',
      args: ['s1', 'then summarize what you would refactor']
    })
    expect(entries()[0]).toContain('follow-up')
  })

  it('makes Option+Enter a plain send while the session is idle', async () => {
    const port = await shellWithSession()

    type('write the adapter')
    await press('Enter', { altKey: true })

    expect(port.calls).toContainEqual({ op: 'prompt', args: ['s1', 'write the adapter'] })
    expect(ops(port)).not.toContain('followUp')
    expect(screen.getByText('write the adapter')).toBeInTheDocument()
  })

  it('queues nothing for a draft of whitespace', async () => {
    const port = await shellWithSession()
    await working()

    type('   ')
    await press('Enter')
    await press('Enter', { altKey: true })

    expect(ops(port)).not.toContain('steer')
    expect(ops(port)).not.toContain('followUp')
  })

  it('shows the delivered message in the transcript when the port says so', async () => {
    const port = await shellWithSession()
    await working()
    type('check the adapter too')
    await press('Enter')

    act(() => {
      port.update((snapshot) => ({
        ...snapshot,
        sessions: snapshot.sessions.map((session) =>
          session.id === 's1' ? { ...session, queue: undefined } : session
        )
      }))
      port.userMessage('s1', 'check the adapter too')
    })

    expect(strip()).toBeNull()
    expect(screen.getByRole('log', { name: 'Transcript' })).toHaveTextContent(
      'check the adapter too'
    )
  })
})

describe('pulling a queued message back', () => {
  async function queued(): Promise<ScriptedPort> {
    const port = await shellWithSession()
    await working()
    type('check the adapter too')
    await press('Enter')
    type('then summarize')
    await press('Enter', { altKey: true })
    return port
  }

  it('restores it to the composer on a click, once the port says it removed it', async () => {
    const port = await queued()

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /queued/ })[0])
    })

    expect(port.calls).toContainEqual({
      op: 'dequeue',
      args: ['s1', 'steering', 'check the adapter too']
    })
    expect(box()).toHaveValue('check the adapter too')
    expect(entries()).toHaveLength(1)
  })

  it('does nothing when the port says it was no longer queued', async () => {
    const port = await queued()
    port.dequeueAnswer = false

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /queued/ })[0])
    })

    expect(box()).toHaveValue('')
    expect(entries()).toHaveLength(2)
  })

  it('takes the bottom-most entry on Option+Up', async () => {
    const port = await queued()

    await press('ArrowUp', { altKey: true })

    // The last follow-up if there is one, which is what the strip shows last.
    expect(port.calls).toContainEqual({ op: 'dequeue', args: ['s1', 'followUp', 'then summarize'] })
    expect(box()).toHaveValue('then summarize')
  })

  it('joins a draft already being typed rather than destroying it', async () => {
    const port = await queued()
    type('and one more thing')

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /queued/ })[0])
    })

    expect(box()).toHaveValue('and one more thing\n\ncheck the adapter too')
    expect(ops(port)).toContain('dequeue')
  })
})

describe('a flush', () => {
  it('hands every queued message back to the composer when the turn is stopped', async () => {
    const port = await shellWithSession()
    await working()
    type('check the adapter too')
    await press('Enter')

    await act(async () => {
      port.flushQueue('s1', [
        { kind: 'steering', text: 'check the adapter too' },
        { kind: 'followUp', text: 'then summarize' }
      ])
      await port.cancel('s1')
    })

    expect(box()).toHaveValue('check the adapter too\n\nthen summarize')
    expect(strip()).toBeNull()
  })

  it('does the same for a turn that failed, keeping the draft in the box', async () => {
    const port = await shellWithSession()
    await working()
    type('a half-typed sentence')

    act(() => {
      port.flushQueue('s1', [{ kind: 'steering', text: 'never delivered' }])
      port.failTurn('s1', 'The provider is overloaded.')
    })

    expect(box()).toHaveValue('a half-typed sentence\n\nnever delivered')
    expect(screen.getByRole('alert')).toHaveTextContent('The provider is overloaded.')
  })
})

describe('the strip and the sessions', () => {
  it('follows the active session and is still there on the way back', async () => {
    const port = await shellWithSession(TWO_SESSIONS)
    await working()
    type('check the adapter too')
    await press('Enter')

    await act(async () => {
      await port.activateSession('s2')
    })
    expect(strip()).toBeNull()

    await act(async () => {
      await port.activateSession('s1')
    })

    expect(entries()[0]).toContain('check the adapter too')
  })

  it('restores a flushed message into the session it was queued in', async () => {
    const port = await shellWithSession(TWO_SESSIONS)
    await working()

    await act(async () => {
      await port.activateSession('s2')
      port.flushQueue('s1', [{ kind: 'steering', text: 'meant for the first session' }])
    })
    expect(box()).toHaveValue('')

    await act(async () => {
      await port.activateSession('s1')
    })

    expect(box()).toHaveValue('meant for the first session')
    expect(sessionLabel({ createdAt: '2026-08-19T14:14:00.000Z' })).toContain('Session')
  })
})
