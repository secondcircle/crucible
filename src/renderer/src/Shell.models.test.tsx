// @vitest-environment jsdom
//
// These two controls must never say anything Crucible made up, so everything
// they show is traced back to what the port reported.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ModelInfo } from '../../shared/agent/port'
import { Shell } from './Shell'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'

const MODELS: readonly ModelInfo[] = [
  { id: 'fake/deterministic', label: 'Fake · deterministic', thinkingLevels: ['off', 'low', 'high'] },
  { id: 'openai/gpt-5.4-mini', label: 'GPT-5.4 mini', thinkingLevels: ['off', 'medium'] }
]

async function shellWithModels(): Promise<ScriptedPort> {
  const port = createScriptedPort(
    oneSession({ model: 'fake/deterministic', thinkingLevel: 'low' })
  )
  port.models = MODELS
  render(<Shell port={port} />)
  await screen.findByRole('button', { name: 'Model: Fake · deterministic' })
  return port
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
