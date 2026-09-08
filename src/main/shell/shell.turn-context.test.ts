// @vitest-environment node
//
// The turn-start hook at the shell's own seam: who gets asked, when, and what
// happens to the answer. Driven against the real fake adapter, with the
// adapter's `prompt` watched so the context that rode a turn is observable
// without any surface showing it.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConversationAdapter } from '../../shared/agent/adapter'
import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import type { ImageAttachment, SessionId, TurnId } from '../../shared/agent/port'
import { createPanelModel } from '../panel/model'
import { storePanelPersistence } from '../panel/store-persistence'
import { createShell, type Shell } from './shell'
import { createShellStore } from './store'

const WORKSPACE = '/repos/crucible'

interface Sent {
  readonly text: string
  readonly context?: string
}

let directory: string
let shell: Shell
let sent: Sent[]
let asked: SessionId[]
let answer: (sessionId: SessionId) => string | undefined

/** The shell as a launch builds it, with the hook and the adapter both watched. */
function build(): void {
  const plain = createFakeAdapter({ pauseMs: 0 })
  const watched: ConversationAdapter = {
    ...plain,
    prompt(
      sessionId: SessionId,
      turnId: TurnId,
      text: string,
      images?: readonly ImageAttachment[],
      context?: string
    ): Promise<void> {
      sent.push({ text, ...(context === undefined ? {} : { context }) })
      return plain.prompt(sessionId, turnId, text, images, context)
    }
  }
  const store = createShellStore(join(directory, 'shell-state.json'))
  shell = createShell({
    store,
    panel: createPanelModel({ persistence: storePanelPersistence(store) }),
    adapter: watched,
    flavor: 'fake',
    pickFolder: async () => WORKSPACE,
    turnContext: (sessionId) => {
      asked.push(sessionId)
      return answer(sessionId)
    }
  })
}

async function withSession(): Promise<SessionId> {
  const workspaceId = await shell.addWorkspace()
  if (workspaceId === null) throw new Error('the picker was supposed to answer')
  return shell.createSession(workspaceId)
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function until(what: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!what()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'crucible-turn-context-'))
  sent = []
  asked = []
  answer = () => 'run 45c8 (build) — interrupted · app quit'
  build()
})

afterEach(() => {
  shell.dispose()
  rmSync(directory, { recursive: true, force: true })
})

describe('the turn-start hook', () => {
  it('rides a user prompt as context and shows up in nothing', async () => {
    const sessionId = await withSession()
    await shell.prompt(sessionId, 'how is the build going?')
    await settled()

    expect(asked).toEqual([sessionId])
    expect(sent).toEqual([
      {
        text: 'how is the build going?',
        context: 'run 45c8 (build) — interrupted · app quit'
      }
    ])
    // The transcript is the conversation and nothing else.
    const transcript = await shell.transcript(sessionId)
    expect(transcript).toContainEqual({ kind: 'user', text: 'how is the build going?' })
    expect(
      transcript.some((item) => JSON.stringify(item).includes('interrupted'))
    ).toBe(false)
  })

  it('is consulted after the turn is claimed, so a refused prompt asks nothing', async () => {
    const sessionId = await withSession()
    const first = shell.prompt(sessionId, 'first')
    // The session is already working, so this one never becomes a turn.
    await expect(shell.prompt(sessionId, 'second')).rejects.toThrow(/already working/)
    await first
    await settled()

    expect(asked).toEqual([sessionId])
  })

  it('sends no context at all when nothing changed', async () => {
    const sessionId = await withSession()
    answer = () => undefined

    await shell.prompt(sessionId, 'anything new?')
    await settled()

    expect(asked).toEqual([sessionId])
    expect(sent).toEqual([{ text: 'anything new?' }])
  })

  it('asks once per user turn, including a queued message that becomes one', async () => {
    const sessionId = await withSession()

    await shell.prompt(sessionId, 'first')
    await settled()
    // No live turn to take it, so it becomes the next prompt — a user turn all
    // the same, and it asks.
    await shell.followUp(sessionId, 'second')
    await settled()

    expect(asked).toEqual([sessionId, sessionId])
    expect(sent.map((one) => one.text)).toEqual(['first', 'second'])
    expect(sent.every((one) => one.context !== undefined)).toBe(true)
  })

  it('never asks for a turn the system started, even when it becomes the prompt', async () => {
    const sessionId = await withSession()

    // What main's orchestrator inbox does with a run's message: a follow-up
    // marked as the system's, which here finds no live turn and prompts.
    await shell.deliver(sessionId, { text: '⚑ Crucible run 45c8 (build) was interrupted.' })
    await settled()

    expect(asked).toEqual([])
    expect(sent).toEqual([{ text: '⚑ Crucible run 45c8 (build) was interrupted.' }])
  })

  // The real ordering of a wake: the hook delivers a run's notice while the
  // user's turn is already claimed, one line before that turn is dispatched.
  it('takes a notice delivered from inside the hook without refusing it', async () => {
    const sessionId = await withSession()
    const refused: string[] = []
    const over: string[] = []
    shell.onEvent((event) => {
      if (event.type === 'turn_ended' || event.type === 'turn_error') over.push(event.type)
    })
    answer = (id) => {
      // What main's orchestrator inbox does when the engine wakes a session.
      void shell
        .deliver(id, { text: '⚑ Crucible run 45c8 (build) was interrupted.' })
        .catch((cause: unknown) => refused.push(String(cause)))
      return 'run 45c8 (build) — interrupted · app quit'
    }

    await shell.prompt(sessionId, 'what is up?')
    await until(() => over.length > 0)

    // Nothing refused and nothing lost. The user's prompt is the only prompt
    // and it carried the context; the notice was offered to the turn that was
    // already claimed and entered the conversation at its boundary.
    expect(refused).toEqual([])
    expect(over).toEqual(['turn_ended'])
    expect(sent).toEqual([
      { text: 'what is up?', context: 'run 45c8 (build) — interrupted · app quit' }
    ])
    expect(asked).toEqual([sessionId])
    const transcript = await shell.transcript(sessionId)
    expect(
      transcript.some(
        (item) => item.kind === 'user' && item.text.includes('was interrupted')
      )
    ).toBe(true)
  })

  it('offers a run message to the live turn rather than taking a turn from it', async () => {
    const sessionId = await withSession()
    const working = shell.prompt(sessionId, 'carry on')
    // Queued into the turn the user just claimed: never refused, never a turn
    // of its own, and it does not ask the hook.
    await shell.deliver(sessionId, { text: '⚑ Crucible run 45c8 (build) was interrupted.' })
    await working
    await settled()

    expect(asked).toEqual([sessionId])
    expect(sent.map((one) => one.text)).toEqual(['carry on'])
    const transcript = await shell.transcript(sessionId)
    expect(
      transcript.some(
        (item) => item.kind === 'user' && item.text.includes('was interrupted')
      )
    ).toBe(true)
  })
})
