// @vitest-environment node
//
// The one road Crucible's own messages take to a session's agent: a run's
// report and a monitor's wake alike. Driven against the real fake adapter, so
// what is tested is the shell's ordering — queued while the agent works,
// delivered when it stops, a turn of its own when it is idle, never lost to a
// stop, and never the user's to take back.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import type { PortEvent, SessionId, SystemCard } from '../../shared/agent/port'
import { createPanelModel } from '../panel/model'
import { storePanelPersistence } from '../panel/store-persistence'
import { createShell, type Shell } from './shell'
import { createShellStore } from './store'

const WORKSPACE = '/repos/crucible'

const CARD: SystemCard = {
  badge: 'monitor',
  tone: 'monitor',
  title: 'CI on PR #482 to finish',
  meta: 'condition met · 6m 40s · 13 checks',
  body: 'last output: completed'
}

const WAKE = '⏳ Crucible monitor m-1f3a — condition met: CI on PR #482 to finish'

let directory: string
let shell: Shell
let events: PortEvent[]
let ended: SessionId[]
let contexts: SessionId[]

function build(): void {
  const store = createShellStore(join(directory, 'shell-state.json'))
  shell = createShell({
    store,
    panel: createPanelModel({ persistence: storePanelPersistence(store) }),
    adapter: createFakeAdapter({ pauseMs: 0 }),
    flavor: 'fake',
    pickFolder: async () => WORKSPACE,
    turnContext: (sessionId) => {
      contexts.push(sessionId)
      return undefined
    },
    onSessionEnded: (sessionId) => ended.push(sessionId)
  })
  shell.onEvent((event) => events.push(event))
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
    await settled()
  }
}

function delivered(): PortEvent[] {
  return events.filter((event) => event.type === 'user_message')
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'crucible-deliver-'))
  events = []
  ended = []
  contexts = []
  build()
})

afterEach(() => {
  shell.dispose()
  rmSync(directory, { recursive: true, force: true })
})

describe('delivering a message of Crucible\u2019s own', () => {
  it('starts a turn of its own when the agent is idle', async () => {
    const sessionId = await withSession()
    await shell.deliver(sessionId, { text: WAKE, card: CARD })
    await until(() => events.some((event) => event.type === 'turn_ended'))

    const [message] = delivered()
    expect(message).toMatchObject({ type: 'user_message', text: WAKE, card: CARD })
  })

  it('is queued into a live turn rather than taking one from it', async () => {
    const sessionId = await withSession()
    const working = shell.prompt(sessionId, 'carry on')
    await shell.deliver(sessionId, { text: WAKE, card: CARD })
    await working
    await until(() => events.some((event) => event.type === 'turn_ended'))

    // One turn, and the wake landed inside it wearing its card.
    expect(events.filter((event) => event.type === 'turn_started')).toHaveLength(1)
    expect(delivered().some((event) => event.type === 'user_message' && event.card !== undefined)).toBe(
      true
    )
  })

  it('is not the user\u2019s turn, so it is offered no user-turn context', async () => {
    const sessionId = await withSession()
    await shell.deliver(sessionId, { text: WAKE })
    await until(() => events.some((event) => event.type === 'turn_ended'))
    expect(contexts).toEqual([])

    await shell.prompt(sessionId, 'and now a person')
    expect(contexts).toEqual([sessionId])
  })

  it('refuses a session that no longer exists', async () => {
    await expect(shell.deliver('s-gone', { text: WAKE })).rejects.toThrow(/no longer open/)
  })

  it('reads as a message nobody typed, card and all, in the transcript', async () => {
    const sessionId = await withSession()
    await shell.deliver(sessionId, { text: WAKE, card: CARD })
    await until(() => events.some((event) => event.type === 'turn_ended'))

    const [message] = delivered()
    expect(message.type === 'user_message' && message.card?.tone).toBe('monitor')
  })
})

describe('a stop under a message of Crucible\u2019s own', () => {
  it('re-queues it rather than handing it back to the composer', async () => {
    const sessionId = await withSession()
    const working = shell.prompt(sessionId, 'carry on for a while')
    await shell.deliver(sessionId, { text: WAKE, card: CARD })
    await shell.cancel(sessionId)
    await working.catch(() => {})
    await until(() => delivered().some((event) => event.type === 'user_message' && event.text === WAKE))

    // Nothing of Crucible's own was ever handed back to the composer.
    const flushed = events.filter((event) => event.type === 'queue_flushed')
    for (const flush of flushed) {
      if (flush.type !== 'queue_flushed') continue
      expect(flush.messages.some((message) => message.text === WAKE)).toBe(false)
    }
    // And it arrived all the same, in a turn of its own.
    const landed = delivered().find((event) => event.type === 'user_message' && event.text === WAKE)
    expect(landed).toBeDefined()
  })

  it('still hands the user\u2019s own queued message back', async () => {
    const sessionId = await withSession()
    const working = shell.prompt(sessionId, 'carry on for a while')
    await shell.steer(sessionId, 'and also this')
    await shell.cancel(sessionId)
    await working.catch(() => {})
    await until(() => events.some((event) => event.type === 'queue_flushed'))

    const flush = events.find((event) => event.type === 'queue_flushed')
    expect(flush?.type === 'queue_flushed' && flush.messages[0].text).toBe('and also this')
  })
})

describe('what the queued strip may do with one', () => {
  it('marks it as the system\u2019s in the queue state', async () => {
    const sessionId = await withSession()
    const working = shell.prompt(sessionId, 'carry on')
    await shell.deliver(sessionId, { text: WAKE })
    await until(() =>
      events.some(
        (event) =>
          event.type === 'state' &&
          event.snapshot.sessions.some((session) =>
            session.queue?.followUp.some((entry) => entry.origin === 'system')
          )
      )
    )
    await working
  })

  it('refuses to hand it back when something asks to dequeue it', async () => {
    const sessionId = await withSession()
    const working = shell.prompt(sessionId, 'carry on')
    await shell.deliver(sessionId, { text: WAKE })
    await expect(shell.dequeue(sessionId, 'followUp', WAKE)).rejects.toThrow(/Crucible’s own/)
    await working
  })
})

describe('the end of a session\u2019s agent', () => {
  it('is announced once when the session is removed', async () => {
    const sessionId = await withSession()
    await shell.removeSession(sessionId)
    expect(ended).toEqual([sessionId])
  })

  it('is announced when the session is reset, because that agent is gone too', async () => {
    const sessionId = await withSession()
    await shell.resetSession(sessionId)
    expect(ended).toEqual([sessionId])
  })

  it('is announced for every session of a removed workspace', async () => {
    const workspaceId = await shell.addWorkspace()
    if (workspaceId === null) throw new Error('the picker was supposed to answer')
    const first = await shell.createSession(workspaceId)
    const second = await shell.createSession(workspaceId)
    await shell.removeWorkspace(workspaceId)
    expect(ended.sort()).toEqual([first, second].sort())
  })
})
