// @vitest-environment node
//
// What the port promises about a jump and about stopping one, driven against
// a stub adapter so the answers are the test's to choose: no Electron, no
// IPC, and no SDK adapter is constructed anywhere in this file.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterEvent, ConversationAdapter } from '../../shared/agent/adapter'
import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import type { PortEvent, SessionId } from '../../shared/agent/port'
import { createPanelModel, type PanelModel } from '../panel/model'
import { storePanelPersistence } from '../panel/store-persistence'
import { createShell, type Shell } from './shell'
import { createShellStore, type ShellStore } from './store'

function over(path: string): { store: ShellStore; panel: PanelModel } {
  const store = createShellStore(path)
  return { store, panel: createPanelModel({ persistence: storePanelPersistence(store) }) }
}

interface Stub {
  readonly adapter: ConversationAdapter
  /** Every session `cancel` was called for, in order. */
  readonly cancelled: SessionId[]
  /** What the next `jump` answers with; a rejection is a genuine failure. */
  jumpAnswer: { cancelled: boolean; editorText?: string } | { failure: string }
  /** Announces what π says while it retries a summary. */
  emit(event: AdapterEvent): void
}

// The fake adapter with three methods of its own: everything else about a
// session — binding, models, transcripts — behaves as it always does.
function stub(): Stub {
  const inner = createFakeAdapter({ pauseMs: 0 })
  const cancelled: SessionId[] = []
  let announce: (event: AdapterEvent) => void = () => undefined

  const held: Stub = {
    cancelled,
    jumpAnswer: { cancelled: false, editorText: 'first' },
    emit: (event) => announce(event),
    adapter: {
      ...inner,
      async jump(): Promise<{ cancelled: boolean; editorText?: string }> {
        const answer = held.jumpAnswer
        if ('failure' in answer) throw new Error(answer.failure)
        return answer
      },
      async cancel(sessionId: SessionId): Promise<void> {
        cancelled.push(sessionId)
        await inner.cancel(sessionId)
      },
      onEvent(listener) {
        const stopInner = inner.onEvent(listener)
        announce = listener
        return () => {
          announce = () => undefined
          stopInner()
        }
      }
    }
  }
  return held
}

let directory: string
let stubbed: Stub
let shell: Shell
let events: PortEvent[]

async function withSession(): Promise<SessionId> {
  const workspaceId = await shell.addWorkspace()
  if (workspaceId === null) throw new Error('the picker was supposed to answer')
  const sessionId = await shell.createSession(workspaceId)
  events.length = 0
  return sessionId
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'crucible-jump-'))
  stubbed = stub()
  shell = createShell({
    ...over(join(directory, 'shell-state.json')),
    adapter: stubbed.adapter,
    flavor: 'fake',
    pickFolder: async () => '/repos/crucible'
  })
  events = []
  shell.onEvent((event) => events.push(event))
})

afterEach(() => {
  shell.dispose()
  rmSync(directory, { recursive: true, force: true })
})

describe('what a jump answers', () => {
  it('is a cancellation carried through, not a rejection', async () => {
    const sessionId = await withSession()
    stubbed.jumpAnswer = { cancelled: true }

    await expect(shell.jump(sessionId, 'n2', { summarize: true })).resolves.toEqual({
      cancelled: true
    })
    // Nothing moved, so nothing about the session changed either.
    expect(events).toEqual([])
  })

  it('is the jump itself, said to have happened', async () => {
    const sessionId = await withSession()

    await expect(shell.jump(sessionId, 'n2', { summarize: false })).resolves.toEqual({
      cancelled: false,
      editorText: 'first'
    })
  })

  it('is a rejection when the summary genuinely failed', async () => {
    const sessionId = await withSession()
    stubbed.jumpAnswer = { failure: 'Opus is overloaded' }

    await expect(shell.jump(sessionId, 'n2', { summarize: true })).rejects.toThrow(
      /overloaded/i
    )
  })

  it('is still a refusal while the session works', async () => {
    const sessionId = await withSession()
    await shell.prompt(sessionId, 'first')

    await expect(shell.jump(sessionId, 'n2', { summarize: true })).rejects.toThrow(
      /working\. Stop it first/
    )
  })
})

describe('stopping what a session is doing', () => {
  // A summarize is not a turn, so a shell that tracks no live turn still has
  // something to stop: only the adapter knows a summary is running.
  it('reaches the adapter when there is no live turn at all', async () => {
    const sessionId = await withSession()

    await shell.cancel(sessionId)

    expect(stubbed.cancelled).toEqual([sessionId])
  })

  it('reaches the adapter for a live turn exactly as it always did', async () => {
    const sessionId = await withSession()
    await shell.prompt(sessionId, 'first')
    // The turn has to be dispatched before a stop means the adapter's cancel.
    for (let tick = 0; tick < 400; tick += 1) await Promise.resolve()

    await shell.cancel(sessionId)

    expect(stubbed.cancelled).toEqual([sessionId])
  })
})

describe('what π says while it retries a summary', () => {
  it('crosses the port unchanged, carrying its session', async () => {
    const sessionId = await withSession()

    stubbed.emit({
      type: 'summarize_retry',
      sessionId,
      attempt: 2,
      maxAttempts: 3,
      delayMs: 4000,
      message: 'Overloaded'
    })

    expect(events).toEqual([
      {
        type: 'summarize_retry',
        sessionId,
        attempt: 2,
        maxAttempts: 3,
        delayMs: 4000,
        message: 'Overloaded'
      }
    ])
  })

  it('is dropped for a session the sidebar no longer holds', async () => {
    const sessionId = await withSession()
    await shell.removeSession(sessionId)
    events.length = 0

    stubbed.emit({
      type: 'summarize_retry',
      sessionId,
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      message: 'Overloaded'
    })

    expect(events).toEqual([])
  })
})
