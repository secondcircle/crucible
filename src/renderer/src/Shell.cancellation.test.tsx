// @vitest-environment jsdom
//
// Stopping is what a person reaches for when an agent is going the wrong way,
// so every path into it is pinned, Escape with nothing running included.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Shell } from './Shell'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { createScriptedCommands } from './testing/scripted-commands'
import { sessionsShown } from './testing/sidebar'
import { settled } from './testing/settled'

async function shellWithSession(): Promise<ScriptedPort> {
  const port = createScriptedPort(oneSession())
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

async function send(text: string): Promise<void> {
  const box = screen.getByLabelText('Message')
  fireEvent.change(box, { target: { value: text } })
  await act(async () => {
    fireEvent.keyDown(box, { key: 'Enter' })
  })
}

const ops = (port: ScriptedPort): string[] => port.calls.map((call) => call.op)

describe('sending', () => {
  it('puts what was sent in the transcript at once, as plain text', async () => {
    const port = await shellWithSession()

    await send('write the adapter')

    expect(screen.getByText('write the adapter')).toBeInTheDocument()
    expect(port.calls).toContainEqual({ op: 'prompt', args: ['s1', 'write the adapter'] })
  })

  it('keeps send unavailable for an empty or blank draft', async () => {
    await shellWithSession()

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'go' } })
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
  })

  it('makes a newline of Shift+Enter rather than a turn', async () => {
    const port = await shellWithSession()
    const box = screen.getByLabelText('Message')

    fireEvent.change(box, { target: { value: 'first line' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })

    expect(ops(port)).not.toContain('prompt')
    expect(box).toHaveValue('first line')
  })
})

describe('while a turn is live', () => {
  it('offers Stop where Send was, and leaves the box editable for a redirect', async () => {
    await shellWithSession()

    await send('write the adapter')

    expect(screen.getByRole('button', { name: /Stop/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    expect(screen.getByLabelText('Message')).toBeEnabled()
  })

  it('queues on Enter rather than starting a second turn', async () => {
    const port = await shellWithSession()
    await send('write the adapter')

    await send('and this too')

    expect(port.calls.filter((call) => call.op === 'prompt')).toHaveLength(1)
    expect(port.calls).toContainEqual({ op: 'steer', args: ['s1', 'and this too'] })
  })

  it('shows genuine elapsed working time', async () => {
    await shellWithSession()

    await send('write the adapter')

    expect(screen.getByText(/agent working · \d+s/)).toBeInTheDocument()
  })
})

describe('stopping', () => {
  it('leaves the partial output with a quiet stopped marker under it', async () => {
    const port = await shellWithSession()
    await send('write the adapter')
    act(() => port.text('s1', 'Starting with the port'))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Stop/ }))
    })

    expect(ops(port)).toContain('cancel')
    expect(screen.getByText('Starting with the port')).toBeInTheDocument()
    expect(screen.getByText('Stopped')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
  })

  it('happens on Escape too', async () => {
    const port = await shellWithSession()
    await send('write the adapter')
    act(() => port.text('s1', 'half a thought'))

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })

    expect(ops(port)).toContain('cancel')
    expect(screen.getByText('Stopped')).toBeInTheDocument()
  })

  it('does nothing on Escape when nothing is running', async () => {
    const port = await shellWithSession()

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })

    expect(ops(port)).not.toContain('cancel')
  })

  it('says nothing more about a turn that was cancelled', async () => {
    const port = await shellWithSession()
    await send('write the adapter')
    const stale = port.turnOf('s1')
    act(() => port.text('s1', 'kept'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Stop/ }))
    })

    act(() => {
      // A delta from the cancelled turn, arriving late.
      port.emit({ type: 'text_delta', sessionId: 's1', turnId: stale ?? '', delta: ' and lost' })
    })

    expect(screen.getByText('kept')).toBeInTheDocument()
    expect(screen.queryByText('kept and lost')).toBeNull()
  })

  it('leaves the session ready for the next prompt', async () => {
    const port = await shellWithSession()
    await send('write the adapter')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Stop/ }))
    })

    await send('do this instead')

    expect(port.calls.filter((call) => call.op === 'prompt')).toEqual([
      { op: 'prompt', args: ['s1', 'write the adapter'] },
      { op: 'prompt', args: ['s1', 'do this instead'] }
    ])
    expect(screen.getByText('do this instead')).toBeInTheDocument()
  })
})

describe('a turn that failed', () => {
  it('renders an error card in place, keeping the text that arrived first', async () => {
    const port = await shellWithSession()
    await send('write the adapter')
    act(() => port.text('s1', 'It began well.'))

    act(() => port.failTurn('s1', 'The provider is overloaded.'))

    expect(screen.getByText('It began well.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('The provider is overloaded.')
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
  })
})
