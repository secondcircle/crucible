// @vitest-environment jsdom
//
// The row under the composer speaks only when there is live state to speak
// about, and keeps its height so nothing around it moves.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Shell } from './Shell'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { createScriptedCommands } from './testing/scripted-commands'
import { sessionsShown } from './testing/sidebar'
import { settled } from './testing/settled'

async function shellWithSession(): Promise<ScriptedPort> {
  const port = createScriptedPort(oneSession({ model: 'fake/deterministic' }))
  port.models = [{ id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off', 'low'] }]
  render(<Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />)
  await sessionsShown()
  await settled()
  return port
}

/** The row itself, which exists in every state whether it says anything or not. */
const footer = (): HTMLElement => document.querySelector('.esc') as HTMLElement

const box = (): HTMLElement => screen.getByLabelText('Message')

async function type(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(box(), { target: { value: text, selectionStart: text.length } })
  })
}

async function attach(): Promise<void> {
  const file = new File([new Uint8Array([1, 2, 3])], 'wide.png', { type: 'image/png' })
  await act(async () => {
    fireEvent.paste(document, {
      clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] }
    })
  })
  await settled()
}

describe('the composer footer', () => {
  it('says nothing at all while the session is idle', async () => {
    await shellWithSession()

    expect(footer()).toBeInTheDocument()
    expect(footer().textContent).toBe('')
  })

  it('names no keystroke it does not have live state for', async () => {
    await shellWithSession()

    await type('/')

    // The command note went with the newline hint: a mode badge above the
    // textarea already says the draft is a command.
    expect(footer().textContent).toBe('')
    expect(document.body.textContent).not.toContain('⇧⏎')
    expect(document.body.textContent).not.toContain('expands before it is sent')
  })

  it('says what a working session is doing, and which keys act on it', async () => {
    const port = await shellWithSession()

    await act(async () => {
      await port.prompt('s1', 'go')
    })

    expect(footer()).toHaveTextContent('agent working')
    expect(footer()).toHaveTextContent('⏎ steer · ⌥⏎ follow-up · esc stop')
    expect(footer().textContent).not.toContain('newline')
  })

  it('warns that a bash run is local, and nothing else', async () => {
    await shellWithSession()

    await type('!npm test')

    expect(footer().textContent).toBe('runs locally in the workspace — nothing goes to the model')
  })

  // Chips are ordinary now: they ride whatever the next keystroke sends, so
  // the row says what it says for a text-only steer and nothing more.
  it('reads the same key map with chips attached', async () => {
    const port = await shellWithSession()
    await attach()

    await act(async () => {
      await port.prompt('s1', 'go')
    })

    expect(footer()).toHaveTextContent('agent working')
    expect(footer()).toHaveTextContent('⏎ steer · ⌥⏎ follow-up · esc stop')
    expect(document.body.textContent).not.toContain('images go with the next prompt')
  })

  it('keeps the row in place through every state', async () => {
    const port = await shellWithSession()
    const idle = footer()

    await act(async () => {
      await port.prompt('s1', 'go')
    })
    expect(footer()).toBe(idle)

    act(() => port.endTurn('s1'))
    expect(footer()).toBe(idle)
    expect(footer().textContent).toBe('')
  })
})
