// @vitest-environment jsdom
//
// A restored session shows no items until its history lands, a window seconds
// wide, and both guards have to read that as "not known to be empty".
import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { TranscriptItem } from '../../shared/agent/port'
import { Shell } from './Shell'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { settled } from './testing/settled'

const MODEL = { id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off', 'low', 'high'] }

const HISTORY: readonly TranscriptItem[] = [
  { kind: 'user', text: 'what did we decide?' },
  { kind: 'assistant', markdown: 'That the sidebar is curated.' }
]

async function shellStillFetching(): Promise<{ port: ScriptedPort; release: () => void }> {
  const port = createScriptedPort(oneSession({ model: MODEL.id, thinkingLevel: 'low' }))
  port.models = [MODEL]
  port.transcripts.set('s1', [...HISTORY])

  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const original = port.transcript.bind(port)
  port.transcript = async (id) => {
    await gate
    return original(id)
  }

  render(<Shell port={port} workspace={createScriptedWorkspace()} />)
  await screen.findByRole('button', { name: /^Session · / })
  await settled()
  return { port, release }
}

it('asks before resetting a non-empty session whose history is still loading (SE-7)', async () => {
  const { port } = await shellStillFetching()

  fireEvent.click(screen.getByRole('button', { name: 'Session menu' }))
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset session' }))
  })

  // The conversation is non-empty and the fetch has not landed, so the reset
  // has to ask first.
  expect(port.calls.map((call) => call.op)).not.toContain('resetSession')
  expect(screen.getByRole('dialog', { name: /Reset this session/ })).toBeInTheDocument()
})

it('warns before a thinking-level change on a non-empty session whose history is still loading (MO-7)', async () => {
  const { port } = await shellStillFetching()

  fireEvent.click(screen.getByRole('button', { name: /^Thinking: / }))
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'high' }))
  })

  // Same window: the change invalidates a non-empty conversation's cache and
  // has to warn first.
  expect(port.calls.map((call) => call.op)).not.toContain('setThinkingLevel')
  expect(screen.getByRole('dialog', { name: /Invalidate this session/ })).toBeInTheDocument()
})
