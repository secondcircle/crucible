// @vitest-environment jsdom
//
// What a compaction looks like from the chat: the setting that governs it, the
// block it leaves in the transcript, and what a send made during one does.
// Driven over the scripted port, so nothing here constructs an SDK adapter.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot, TranscriptItem } from '../../shared/agent/port'
import type { CompactionRecord } from '../../shared/compaction/record'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { settled } from './testing/settled'

const RECORD: CompactionRecord = {
  trigger: 'idle',
  tokensBefore: 214_000,
  tokensAfter: 48_000
}

const SUMMARY = '## Where we are\n\nThe retry work stands here.'

async function shell(
  snapshot: Partial<ShellSnapshot> = oneSession(),
  history: readonly TranscriptItem[] = []
): Promise<ScriptedPort> {
  const port = createScriptedPort(snapshot)
  port.models = [{ id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off'] }]
  port.transcripts.set('s1', history)
  render(
    <Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />
  )
  await settled()
  return port
}

async function click(name: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
  await settled()
}

async function escape(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(document, { key: 'Escape' })
  })
  await settled()
}

async function openCompactionSettings(): Promise<void> {
  await click('Settings')
  await act(async () => {
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', {
        name: /Compaction/
      })
    )
  })
  await settled()
}

const composer = (): HTMLTextAreaElement =>
  screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement

async function type(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(composer(), { target: { value: text } })
  })
  await settled()
}

async function send(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(composer(), { key: 'Enter' })
  })
  await settled()
}

const waitDialog = (): HTMLElement | null =>
  screen.queryByRole('dialog', { name: 'Compacting the conversation' })

describe('the compaction section', () => {
  it('shows the switch on and the threshold in thousands', async () => {
    await shell()
    await openCompactionSettings()

    expect(screen.getByRole('switch', { name: 'Compact automatically' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByLabelText('Compact at, in thousands of tokens')).toHaveValue(200)
  })

  it('turns the switch off through the port', async () => {
    const port = await shell()
    await openCompactionSettings()

    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Compact automatically' }))
    })
    await settled()

    expect(port.compaction).toEqual({ enabled: false, thresholdK: 200 })
    expect(screen.getByRole('switch', { name: 'Compact automatically' })).toHaveAttribute(
      'aria-checked',
      'false'
    )
  })

  // The field is in k, so `100` means a hundred thousand and nobody types six
  // digits.
  it('writes a typed threshold as thousands of tokens', async () => {
    const port = await shell()
    await openCompactionSettings()

    const field = screen.getByLabelText('Compact at, in thousands of tokens')
    await act(async () => {
      fireEvent.change(field, { target: { value: '100' } })
      fireEvent.blur(field)
    })
    await settled()

    expect(port.compaction).toEqual({ enabled: true, thresholdK: 100 })
  })

  it('clamps a threshold that would compact a window into itself', async () => {
    const port = await shell()
    await openCompactionSettings()

    const field = screen.getByLabelText('Compact at, in thousands of tokens')
    await act(async () => {
      fireEvent.change(field, { target: { value: '1' } })
      fireEvent.blur(field)
    })
    await settled()

    expect(port.compaction.thresholdK).toBe(20)
  })
})

describe('the block a compaction leaves', () => {
  it('states what fired it and what the window went from and to', async () => {
    const port = await shell()

    await act(async () => {
      port.compacted('s1', SUMMARY, RECORD)
    })
    await settled()

    const card = screen.getByLabelText('Context summary')
    expect(card.textContent).toContain('idle, cache still warm')
    expect(card.textContent).toContain('214k → 48k')
    expect(card.textContent).toContain('The retry work stands here.')
  })

  it('names the threshold and the window edge as themselves', async () => {
    const port = await shell()

    await act(async () => {
      port.compacted('s1', SUMMARY, { ...RECORD, trigger: 'windowEdge' })
    })
    await settled()

    expect(screen.getByLabelText('Context summary').textContent).toContain('at the model’s window')
  })

  // A compaction changes what the model reads and nothing about what happened.
  it('leaves everything above it in the transcript', async () => {
    const port = await shell(oneSession(), [{ kind: 'user', text: 'The first ask, long ago.' }])

    await act(async () => {
      port.compacted('s1', SUMMARY, RECORD)
    })
    await settled()

    expect(screen.getByText('The first ask, long ago.')).toBeTruthy()
    expect(screen.getByLabelText('Context summary')).toBeTruthy()
  })
})

describe('a send made while the conversation is being compacted', () => {
  it('waits for it rather than racing it, and goes out when it lands', async () => {
    const port = await shell()
    await act(async () => {
      port.compactionStarted('s1')
    })
    await settled()

    await type('the next thing')
    await send()

    expect(waitDialog()).not.toBeNull()
    expect(port.calls.map((call) => call.op)).not.toContain('prompt')

    await act(async () => {
      port.compacted('s1', SUMMARY, RECORD)
    })
    await settled()

    expect(waitDialog()).toBeNull()
    expect(port.calls.filter((call) => call.op === 'prompt')).toHaveLength(1)
  })

  // Escape stops the compaction rather than the message: the draft was never
  // cleared, so the words are where the user left them.
  it('is cancelled by Escape, with the message still in the composer', async () => {
    const port = await shell()
    await act(async () => {
      port.compactionStarted('s1')
    })
    await settled()

    await type('the next thing')
    await send()
    await escape()

    expect(waitDialog()).toBeNull()
    expect(port.calls.map((call) => call.op)).toContain('cancel')
    expect(port.calls.map((call) => call.op)).not.toContain('prompt')
    expect(composer()).toHaveValue('the next thing')
  })
})

describe('the send after an idle compaction', () => {
  // The compaction replaced the prefix with a small one, so the choice would
  // be pricing a re-bill that is not going to happen.
  it('goes straight through, however long the session then sat', async () => {
    const port = await shell(
      oneSession({
        idleCompacted: true,
        cachedPrefix: {
          at: '2026-09-18T02:00:00.000Z',
          tokens: 214_000,
          rebillDollars: 4.1,
          retention: '1h'
        }
      })
    )

    await type('picking this back up')
    await send()

    expect(
      screen.queryByRole('dialog', { name: 'The cache for this conversation has expired' })
    ).toBeNull()
    expect(port.calls.filter((call) => call.op === 'prompt')).toHaveLength(1)
  })
})
