// @vitest-environment jsdom
//
// Reproduction left by review: while a restored session's settled history is
// still being fetched, the shell treats the session as empty, and both
// conversation guards silently skip.
//
// `Shell.tsx` decides "the conversation is non-empty" from `view.items` alone
// (`items.length === 0` in `resetSession` and `selectThinkingLevel`), without
// consulting the view's own `loaded` flag. Until `transcript()` resolves the
// items are `[]` whatever the conversation holds, so in that window:
//
// - Reset Session applies without the confirmation SE-7 requires of a
//   non-empty conversation.
// - A thinking-level change applies without the cache-invalidation warning
//   MO-7 requires — and the window is widest exactly where that warning
//   matters, because `shell.transcript()` awaits the session's bind, and an
//   SDK-flavor rebind after a relaunch is seconds long (dynamic SDK import,
//   settings, resource-loader reload, ModelRuntime.create, session open).
//
// The gated `transcript()` below is that window, held open. The fix is the
// builder's; the honest reading of an unloaded view is "not known to be
// empty", which asks first.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { TranscriptItem } from '../../shared/agent/port'
import { Shell } from './Shell'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'

const MODEL = { id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off', 'low', 'high'] }

const HISTORY: readonly TranscriptItem[] = [
  { kind: 'user', text: 'what did we decide?' },
  { kind: 'assistant', markdown: 'That the sidebar is curated.' }
]

/** A shell over a non-empty restored session whose history has not landed yet. */
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

  render(<Shell port={port} />)
  await screen.findByRole('button', { name: /^Session · / })
  return { port, release }
}

it('asks before resetting a non-empty session whose history is still loading (SE-7)', async () => {
  const { port } = await shellStillFetching()

  fireEvent.click(screen.getByRole('button', { name: 'Session menu' }))
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset session' }))
  })

  // The conversation is non-empty — the fetch just has not landed — so the
  // reset must ask first, not apply.
  expect(port.calls.map((call) => call.op)).not.toContain('resetSession')
  expect(screen.getByRole('dialog', { name: /Reset this session/ })).toBeInTheDocument()
})

it('warns before a thinking-level change on a non-empty session whose history is still loading (MO-7)', async () => {
  const { port } = await shellStillFetching()

  fireEvent.click(screen.getByRole('button', { name: /^Thinking: / }))
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'high' }))
  })

  // Same window, same conflation: the change invalidates a non-empty
  // conversation's cache and must warn first.
  expect(port.calls.map((call) => call.op)).not.toContain('setThinkingLevel')
  expect(screen.getByRole('dialog', { name: /Invalidate this session/ })).toBeInTheDocument()
})
