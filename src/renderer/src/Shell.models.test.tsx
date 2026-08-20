// @vitest-environment jsdom
//
// These two controls must never say anything Crucible made up, so everything
// they show is traced back to what the port reported.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ModelInfo } from '../../shared/agent/port'
import { Shell } from './Shell'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { createScriptedCommands } from './testing/scripted-commands'
import { sessionsShown } from './testing/sidebar'
import { settled } from './testing/settled'

const MODELS: readonly ModelInfo[] = [
  { id: 'fake/deterministic', label: 'Fake · deterministic', thinkingLevels: ['off', 'low', 'high'] },
  { id: 'openai/gpt-5.4-mini', label: 'GPT-5.4 mini', thinkingLevels: ['off', 'medium'] }
]

// The two ids Crucible knows by heart, under the labels a port reports for
// them. The ring's order is the module's, not this list's.
const OPUS = 'anthropic/claude-opus-5'
const FABLE = 'anthropic/claude-fable-5'

const RING_MODELS: readonly ModelInfo[] = [
  { id: OPUS, label: 'Claude Opus 5', thinkingLevels: ['off', 'high'] },
  { id: FABLE, label: 'Claude Fable 5', thinkingLevels: ['off', 'high'] }
]

async function shellWithModels(): Promise<ScriptedPort> {
  const port = createScriptedPort(
    oneSession({ model: 'fake/deterministic', thinkingLevel: 'low' })
  )
  port.models = MODELS
  render(<Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />)
  await screen.findByRole('button', { name: 'Model: Fake · deterministic' })
  await settled()
  return port
}

async function shellWith(
  models: readonly ModelInfo[],
  model?: string
): Promise<ScriptedPort> {
  const port = createScriptedPort(oneSession(model === undefined ? {} : { model }))
  port.models = models
  render(<Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />)
  await sessionsShown()
  await settled()
  return port
}

const chip = (): HTMLElement => screen.getByRole('button', { name: /^Model: / })

async function shiftTab(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
  })
}

function openPicker(): void {
  fireEvent.click(screen.getByRole('button', { name: /^Model: / }))
}

function openThinking(): void {
  fireEvent.click(screen.getByRole('button', { name: /^Thinking: / }))
}

describe('the model picker', () => {
  it('shows the session\u2019s real model on the chip', async () => {
    await shellWithModels()

    expect(screen.getByRole('button', { name: 'Model: Fake · deterministic' })).toBeInTheDocument()
  })

  it('lists only what the port reported, and filters as you type', async () => {
    await shellWithModels()

    openPicker()
    const picker = screen.getByRole('dialog', { name: 'Model picker' })
    expect(within(picker).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Fake · deterministic✓',
      'GPT-5.4 mini'
    ])

    fireEvent.change(within(picker).getByLabelText('Search models'), { target: { value: 'gpt' } })

    expect(within(picker).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'GPT-5.4 mini'
    ])
  })

  it('selects on click, and the chip follows the session', async () => {
    const port = await shellWithModels()

    openPicker()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /GPT-5.4 mini/ }))
    })

    expect(port.calls).toContainEqual({ op: 'setModel', args: ['s1', 'openai/gpt-5.4-mini'] })
    expect(screen.getByRole('button', { name: 'Model: GPT-5.4 mini' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Model picker' })).toBeNull()
  })

  it('selects the first match on Enter', async () => {
    const port = await shellWithModels()

    openPicker()
    const search = screen.getByLabelText('Search models')
    fireEvent.change(search, { target: { value: 'gpt' } })
    await act(async () => {
      fireEvent.keyDown(search, { key: 'Enter' })
    })

    expect(port.calls).toContainEqual({ op: 'setModel', args: ['s1', 'openai/gpt-5.4-mini'] })
  })

  it('closes on Escape without changing anything', async () => {
    const port = await shellWithModels()

    openPicker()
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })

    expect(screen.queryByRole('dialog', { name: 'Model picker' })).toBeNull()
    expect(port.calls.map((call) => call.op)).not.toContain('setModel')
  })
})

// Display only, and only on the chip: the picker keeps the port's own labels
// so an unfamiliar model stays identifiable.
describe('model aliases', () => {
  it('shows the alias on the chip while the picker keeps the full name', async () => {
    await shellWith(RING_MODELS, OPUS)

    expect(chip()).toHaveTextContent('Opus')
    expect(chip()).toHaveAccessibleName('Model: Opus')

    openPicker()
    const picker = screen.getByRole('dialog', { name: 'Model picker' })
    expect(within(picker).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Claude Opus 5✓',
      'Claude Fable 5'
    ])
  })

  it('shows the port’s own label for a model it does not know by heart', async () => {
    await shellWith(MODELS, 'openai/gpt-5.4-mini')

    expect(chip()).toHaveAccessibleName('Model: GPT-5.4 mini')

    openPicker()
    const picker = screen.getByRole('dialog', { name: 'Model picker' })
    expect(within(picker).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Fake · deterministic',
      'GPT-5.4 mini✓'
    ])
  })
})

// Nothing on screen names the keystroke, so every one of these drives the key
// itself and reads the chip.
describe('the model ring', () => {
  it('cycles to the next ring model without opening the picker', async () => {
    const port = await shellWith(RING_MODELS, OPUS)

    await shiftTab()

    expect(port.calls).toContainEqual({ op: 'setModel', args: ['s1', FABLE] })
    expect(chip()).toHaveTextContent('Fable')
    expect(screen.queryByRole('dialog')).toBeNull()

    await shiftTab()

    expect(port.calls).toContainEqual({ op: 'setModel', args: ['s1', OPUS] })
    expect(chip()).toHaveTextContent('Opus')
  })

  it('skips a ring model the adapter did not list, and then does nothing', async () => {
    const listed = RING_MODELS.filter((model) => model.id === FABLE)
    const port = await shellWith(listed, 'openai/gpt-5.4-mini')

    await shiftTab()
    expect(port.calls).toContainEqual({ op: 'setModel', args: ['s1', FABLE] })
    expect(chip()).toHaveTextContent('Fable')

    await shiftTab()

    expect(port.calls.filter((call) => call.op === 'setModel')).toHaveLength(1)
  })

  it('does nothing at all when the adapter listed no ring model', async () => {
    const port = await shellWith(MODELS, 'fake/deterministic')

    await shiftTab()

    expect(port.calls.map((call) => call.op)).not.toContain('setModel')
    expect(chip()).toHaveTextContent('Fake · deterministic')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('works mid-turn, changing the chip before the port has answered', async () => {
    const port = await shellWith(RING_MODELS, OPUS)
    // Held open, so the frame the key lands in is the one under test.
    let answer: (() => void) | undefined
    const asked: string[] = []
    port.setModel = (_sessionId, model) => {
      asked.push(model)
      return new Promise<void>((resolve) => {
        answer = resolve
      })
    }

    await act(async () => {
      await port.prompt('s1', 'go')
    })
    await shiftTab()

    expect(chip()).toHaveTextContent('Fable')
    // The button itself stays disabled while the session works; only the
    // keystroke bypasses it.
    expect(chip()).toBeDisabled()
    expect(asked).toEqual([FABLE])
    expect(screen.queryByRole('dialog')).toBeNull()

    await act(async () => {
      answer?.()
    })
  })

  it('falls back to the snapshot when the port refuses', async () => {
    const port = await shellWith(RING_MODELS, OPUS)
    port.setModel = () => Promise.reject(new Error('That model is not available.'))

    await shiftTab()
    await settled()

    expect(chip()).toHaveTextContent('Opus')
    expect(screen.getByRole('alert')).toHaveTextContent('That model is not available.')
  })

  it('cycles from under an open popover, and inserts nothing into the draft', async () => {
    const port = await shellWith(RING_MODELS, OPUS)
    const box = screen.getByLabelText('Message')
    await act(async () => {
      fireEvent.change(box, { target: { value: '/', selectionStart: 1 } })
    })
    await settled()
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeInTheDocument()

    await act(async () => {
      fireEvent.keyDown(box, { key: 'Tab', shiftKey: true })
    })

    expect(port.calls).toContainEqual({ op: 'setModel', args: ['s1', FABLE] })
    expect(box).toHaveValue('/')
  })

  it('is left alone while a modal surface is up', async () => {
    const port = await shellWith(RING_MODELS, OPUS)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    })
    await shiftTab()

    expect(port.calls.map((call) => call.op)).not.toContain('setModel')
  })
})

describe('the thinking control', () => {
  it('offers exactly the selected model\u2019s native levels', async () => {
    const port = await shellWithModels()

    openThinking()
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'off',
      'low',
      'high'
    ])

    // Switch to the other model: the menu now offers that model's levels, not
    // a fixed low/medium/high.
    openPicker()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /GPT-5.4 mini/ }))
    })
    openThinking()

    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'off',
      'medium'
    ])
    expect(port.calls.map((call) => call.op)).not.toContain('setThinkingLevel')
  })

  it('changes the level of an empty session without asking', async () => {
    const port = await shellWithModels()

    openThinking()
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'high' }))
    })

    expect(port.calls).toContainEqual({ op: 'setThinkingLevel', args: ['s1', 'high'] })
    expect(screen.getByRole('button', { name: 'Thinking: high' })).toBeInTheDocument()
  })
})

describe('the cache guard', () => {
  async function withConversation(): Promise<ScriptedPort> {
    const port = await shellWithModels()
    const box = screen.getByLabelText('Message')
    fireEvent.change(box, { target: { value: 'say something' } })
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' })
    })
    act(() => {
      port.text('s1', 'something')
      port.endTurn('s1')
    })
    return port
  }

  it('asks before changing the level of a session that has a conversation', async () => {
    const port = await withConversation()

    openThinking()
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'high' }))
    })

    expect(screen.getByRole('dialog', { name: /Invalidate this session/ })).toBeInTheDocument()
    expect(port.calls.map((call) => call.op)).not.toContain('setThinkingLevel')
  })

  it('honors keeping the current level', async () => {
    const port = await withConversation()
    openThinking()
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'high' }))
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep current level' }))
    })

    expect(port.calls.map((call) => call.op)).not.toContain('setThinkingLevel')
    expect(screen.getByRole('button', { name: 'Thinking: low' })).toBeInTheDocument()
  })

  it('honors changing anyway', async () => {
    const port = await withConversation()
    openThinking()
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'high' }))
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Change anyway' }))
    })

    expect(port.calls).toContainEqual({ op: 'setThinkingLevel', args: ['s1', 'high'] })
    expect(screen.getByRole('button', { name: 'Thinking: high' })).toBeInTheDocument()
  })
})

describe('while a session works', () => {
  it('takes both controls away until the turn is over', async () => {
    const port = await shellWithModels()

    await act(async () => {
      await port.prompt('s1', 'go')
    })

    expect(screen.getByRole('button', { name: /^Model: / })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^Thinking: / })).toBeDisabled()

    act(() => port.endTurn('s1'))

    expect(screen.getByRole('button', { name: /^Model: / })).toBeEnabled()
  })
})

describe('the context meter', () => {
  it('says nothing until the port reports real usage', async () => {
    const port = await shellWithModels()

    expect(screen.getByLabelText('Context usage')).toHaveTextContent('— ctx')

    act(() =>
      port.update((snapshot) => ({
        ...snapshot,
        sessions: snapshot.sessions.map((session) => ({
          ...session,
          usage: { usedTokens: 68_000, contextWindow: 200_000 }
        }))
      }))
    )

    const meter = screen.getByLabelText('Context usage')
    expect(meter).toHaveTextContent('34% ctx')
    expect(meter).toHaveTextContent('68k / 200k')
  })
})
