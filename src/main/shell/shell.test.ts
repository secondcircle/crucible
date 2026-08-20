// @vitest-environment node
//
// Driven against the real fake adapter and a real store, with no Electron and
// no IPC, which is the point of having put the rules here.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterEventListener, ConversationAdapter } from '../../shared/agent/adapter'
import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import type { PortEvent, SessionId, ShellSnapshot } from '../../shared/agent/port'
import { createPanelModel, type PanelModel } from '../panel/model'
import { storePanelPersistence } from '../panel/store-persistence'
import { createShell, type Shell } from './shell'
import { createShellStore, type ShellStore } from './store'

// The shell's panel is the app's: one model over the same store file, so what
// a panel test asserts here is what a launch does.
function over(path: string): { store: ShellStore; panel: PanelModel } {
  const store = createShellStore(path)
  return { store, panel: createPanelModel({ persistence: storePanelPersistence(store) }) }
}

const WORKSPACE = '/repos/crucible'

let directory: string
let file: string
let picked: string | null
let adapter: ConversationAdapter
let shell: Shell
let events: PortEvent[]

function build(options: { seedWorkspacePath?: string } = {}): void {
  adapter = createFakeAdapter({ pauseMs: 0 })
  shell = createShell({
    ...over(file),
    adapter,
    pickFolder: async () => picked,
    ...options
  })
  events = []
  shell.onEvent((event) => events.push(event))
}

async function withSession(): Promise<{ workspaceId: string; sessionId: SessionId }> {
  picked = WORKSPACE
  const workspaceId = await shell.addWorkspace()
  if (workspaceId === null) throw new Error('the picker was supposed to answer')
  const sessionId = await shell.createSession(workspaceId)
  return { workspaceId, sessionId }
}

const types = (): string[] => events.map((event) => event.type)

const sessionOf = (snapshot: ShellSnapshot, id: SessionId) =>
  snapshot.sessions.find((session) => session.id === id)

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'crucible-shell-'))
  file = join(directory, 'shell-state.json')
  picked = null
  build()
})

afterEach(() => {
  shell.dispose()
  rmSync(directory, { recursive: true, force: true })
})

describe('workspaces', () => {
  it('adds what the picker returned, activates it, and says so', async () => {
    picked = WORKSPACE

    const id = await shell.addWorkspace()
    const snapshot = await shell.snapshot()

    expect(id).not.toBeNull()
    expect(snapshot.workspaces).toEqual([{ id, name: 'crucible', path: WORKSPACE }])
    expect(snapshot.activeWorkspaceId).toBe(id)
    expect(types()).toEqual(['state'])
  })

  it('changes nothing when the picker is cancelled', async () => {
    picked = null

    const id = await shell.addWorkspace()

    expect(id).toBeNull()
    expect((await shell.snapshot()).workspaces).toEqual([])
    expect(events).toEqual([])
  })

  it('takes a seeded workspace as if it had been picked', async () => {
    build({ seedWorkspacePath: '/repos/seeded' })

    const snapshot = await shell.snapshot()

    expect(snapshot.workspaces).toEqual([
      { id: snapshot.activeWorkspaceId, name: 'seeded', path: '/repos/seeded' }
    ])
  })

  it('cancels the live work of a workspace it removes, and keeps the folder', async () => {
    const { workspaceId, sessionId } = await withSession()
    // Removed mid-turn, so what is asserted is that the work stopped rather
    // than that it happened to be over already.
    await shell.prompt(sessionId, 'a sentence said before the removal')

    await shell.removeWorkspace(workspaceId)
    await settled()
    const snapshot = await shell.snapshot()

    expect(snapshot.workspaces).toEqual([])
    expect(snapshot.sessions).toEqual([])
    expect(types()).toContain('turn_cancelled')
    // The conversation is still the adapter's to find: removal forgot a
    // sidebar entry, not a history.
    expect(
      await adapter.searchHistory(WORKSPACE, 'a sentence said before the removal')
    ).toHaveLength(1)
  })
})

describe('curated sessions', () => {
  it('creates a session in the workspace, activates it, and binds a conversation', async () => {
    const { workspaceId, sessionId } = await withSession()
    const snapshot = await shell.snapshot()

    expect(snapshot.sessions).toHaveLength(1)
    expect(sessionOf(snapshot, sessionId)).toMatchObject({
      workspaceId,
      working: false,
      model: 'fake/deterministic'
    })
    expect(snapshot.activeSessionId).toBe(sessionId)
  })

  it('never populates itself from history', async () => {
    picked = WORKSPACE
    const workspaceId = await shell.addWorkspace()
    if (workspaceId === null) throw new Error('the picker was supposed to answer')

    const found = await shell.searchHistory(workspaceId, '')

    expect(found.length).toBeGreaterThan(0)
    expect((await shell.snapshot()).sessions).toEqual([])
  })

  it('forgets a removed session without deleting its conversation', async () => {
    const { workspaceId, sessionId } = await withSession()
    await shell.prompt(sessionId, 'a sentence worth finding')

    await shell.removeSession(sessionId)
    await settled()

    expect((await shell.snapshot()).sessions).toEqual([])
    expect(types()).toContain('turn_cancelled')
    const found = await shell.searchHistory(workspaceId, 'a sentence worth finding')
    expect(found).toHaveLength(1)
  })

  it('keeps the sidebar identity through a reset and detaches the conversation', async () => {
    const { workspaceId, sessionId } = await withSession()
    await shell.prompt(sessionId, 'before the reset')
    await settled()

    await shell.resetSession(sessionId)

    const snapshot = await shell.snapshot()
    expect(snapshot.sessions.map((session) => session.id)).toEqual([sessionId])
    expect(await shell.transcript(sessionId)).toEqual([])
    expect(await shell.searchHistory(workspaceId, 'before the reset')).toHaveLength(1)
  })

  it('activates an existing entry rather than resuming a conversation twice', async () => {
    const { workspaceId, sessionId } = await withSession()
    await shell.prompt(sessionId, 'the one conversation')
    await settled()
    const [match] = await shell.searchHistory(workspaceId, 'the one conversation')

    const resumed = await shell.resumeSession(workspaceId, match.ref)

    expect(resumed).toBe(sessionId)
    expect((await shell.snapshot()).sessions).toHaveLength(1)
  })

  it('adds a curated entry when a conversation is resumed for the first time', async () => {
    const { workspaceId, sessionId } = await withSession()
    await shell.prompt(sessionId, 'detached by the reset')
    await settled()
    await shell.resetSession(sessionId)
    const [match] = await shell.searchHistory(workspaceId, 'detached by the reset')

    const resumed = await shell.resumeSession(workspaceId, match.ref)

    expect(resumed).not.toBe(sessionId)
    const snapshot = await shell.snapshot()
    expect(snapshot.sessions).toHaveLength(2)
    expect(snapshot.activeSessionId).toBe(resumed)
    expect(await shell.transcript(resumed)).toContainEqual({
      kind: 'user',
      text: 'detached by the reset'
    })
  })
})

describe('turns', () => {
  it('emits one start, the stream, and one terminal event', async () => {
    const { sessionId } = await withSession()
    events.length = 0

    await shell.prompt(sessionId, 'hello')
    await settled()

    const turnEvents = types().filter((type) => type !== 'state')
    expect(turnEvents[0]).toBe('turn_started')
    expect(turnEvents.at(-1)).toBe('turn_ended')
    expect(turnEvents.filter((type) => type === 'turn_started')).toHaveLength(1)
    expect(turnEvents.filter((type) => type === 'turn_ended')).toHaveLength(1)
  })

  it('refuses a second prompt while the session is working, and mints no turn', async () => {
    const { sessionId } = await withSession()
    const first = shell.prompt(sessionId, 'hello')

    await expect(shell.prompt(sessionId, 'again')).rejects.toThrow(/already working/i)

    await first
    await settled()
    expect(types().filter((type) => type === 'turn_started')).toHaveLength(1)
  })

  it('refuses a prompt to a session that is not curated', async () => {
    await expect(shell.prompt('nobody', 'hello')).rejects.toThrow(/no longer open/i)
  })

  it('says a session is working while its turn is live, and idle after', async () => {
    const { sessionId } = await withSession()

    const working: boolean[] = []
    shell.onEvent((event) => {
      if (event.type === 'state') {
        working.push(sessionOf(event.snapshot, sessionId)?.working === true)
      }
    })
    await shell.prompt(sessionId, 'hello')
    await settled()

    expect(working[0]).toBe(true)
    expect(working.at(-1)).toBe(false)
    expect(sessionOf(await shell.snapshot(), sessionId)?.working).toBe(false)
  })

  it('folds the adapter\u2019s usage into the snapshot', async () => {
    const { sessionId } = await withSession()

    await shell.prompt(sessionId, 'hello')
    await settled()

    const usage = sessionOf(await shell.snapshot(), sessionId)?.usage
    expect(usage?.usedTokens).toBeGreaterThan(0)
    expect(usage?.contextWindow).toBeGreaterThan(usage?.usedTokens ?? 0)
  })

  it('runs two sessions at once, each with its own turn', async () => {
    const { workspaceId, sessionId: first } = await withSession()
    const second = await shell.createSession(workspaceId)
    events.length = 0

    await Promise.all([shell.prompt(first, 'one'), shell.prompt(second, 'two')])
    await settled()

    for (const id of [first, second]) {
      const own = events.filter((event) => 'sessionId' in event && event.sessionId === id)
      expect(own.map((event) => event.type)).toContain('turn_started')
      expect(own.map((event) => event.type)).toContain('turn_ended')
    }
  })
})

// π's queueing semantics as they cross the port, including the turn started
// for a message that found none.
describe('queued messages', () => {
  /** Acts once, the first time a call in the live turn starts. */
  function atFirstCall(act: () => void): void {
    let done = false
    shell.onEvent((event) => {
      if (event.type !== 'tool_started' || done) return
      done = true
      act()
    })
  }

  const queueOf = async (id: SessionId) => sessionOf(await shell.snapshot(), id)?.queue

  it('starts a turn for a steering message with nothing to steer, and announces it', async () => {
    const { sessionId } = await withSession()
    events.length = 0

    await shell.steer(sessionId, 'do this instead')
    await settled()

    // Nobody echoed it, so the port says it itself, right after the start.
    const said = types().filter((type) => type !== 'state')
    expect(said[0]).toBe('turn_started')
    expect(said[1]).toBe('user_message')
    expect(events.find((event) => event.type === 'user_message')).toMatchObject({
      text: 'do this instead'
    })
    expect(await shell.transcript(sessionId)).toContainEqual({
      kind: 'user',
      text: 'do this instead'
    })
  })

  it('does the same for a follow-up, so neither key is ever dead', async () => {
    const { sessionId } = await withSession()
    events.length = 0

    await shell.followUp(sessionId, 'and this')
    await settled()

    expect(types()).toContain('user_message')
    expect(types()).toContain('turn_ended')
  })

  it('carries the queue in the snapshot until the message is delivered', async () => {
    const { sessionId } = await withSession()
    const seen: (readonly string[] | undefined)[] = []
    shell.onEvent((event) => {
      if (event.type === 'state') seen.push(sessionOf(event.snapshot, sessionId)?.queue?.steering)
    })
    atFirstCall(() => {
      void shell.steer(sessionId, 'read the adapter too')
    })

    await shell.prompt(sessionId, 'hello')
    await settled()

    expect(seen.some((steering) => steering?.includes('read the adapter too'))).toBe(true)
    // Delivered, so the strip has nothing left to show and the transcript has
    // it instead.
    expect(await queueOf(sessionId)).toBeUndefined()
    expect(types()).toContain('user_message')
    expect(await shell.transcript(sessionId)).toContainEqual({
      kind: 'user',
      text: 'read the adapter too'
    })
  })

  it('never lets a turn end with a message still queued behind it', async () => {
    const { sessionId } = await withSession()
    atFirstCall(() => {
      void shell.steer(sessionId, 'redirect')
      void shell.followUp(sessionId, 'afterwards')
      void shell.cancel(sessionId)
    })

    await shell.prompt(sessionId, 'hello')
    await settled()

    // Both queues come back, steering first, and nothing fires at the plan the
    // user just killed.
    const flushed = events.find((event) => event.type === 'queue_flushed')
    expect(flushed).toMatchObject({
      messages: [
        { kind: 'steering', text: 'redirect' },
        { kind: 'followUp', text: 'afterwards' }
      ]
    })
    expect(types()).not.toContain('user_message')
    expect(types().indexOf('queue_flushed')).toBeLessThan(types().indexOf('turn_cancelled'))
    expect(await queueOf(sessionId)).toBeUndefined()
  })

  it('hands the queue back on a reset, and keeps the sidebar identity', async () => {
    const { sessionId } = await withSession()
    let reset: Promise<void> | undefined
    atFirstCall(() => {
      reset = shell
        .steer(sessionId, 'not this conversation')
        .then(() => shell.resetSession(sessionId))
    })

    await shell.prompt(sessionId, 'hello')
    await settled()
    await reset

    expect(types()).toContain('queue_flushed')
    expect(await queueOf(sessionId)).toBeUndefined()
    expect((await shell.snapshot()).sessions.map((session) => session.id)).toEqual([sessionId])
  })

  it('leaves nothing of a removed session’s queue behind', async () => {
    const { sessionId } = await withSession()
    atFirstCall(() => {
      void shell.steer(sessionId, 'never delivered')
    })

    await shell.prompt(sessionId, 'hello')
    await shell.removeSession(sessionId)
    await settled()

    expect((await shell.snapshot()).sessions).toEqual([])
  })

  // A removed session has no composer to hand a flushed queue back to, so the
  // renderer would file the text under a session it can never show.
  it('discards a removed session’s queue rather than handing it back to nothing', async () => {
    const { sessionId } = await withSession()
    const listeners = new Set<AdapterEventListener>()
    const flushing: ConversationAdapter = {
      ...adapter,
      // Runs until it is cancelled, so the turn is genuinely dispatched when
      // the removal reaches for it.
      prompt(): Promise<void> {
        return new Promise(() => {})
      },
      async cancel(id: SessionId): Promise<void> {
        listeners.forEach((listener) =>
          listener({
            type: 'queue_flushed',
            sessionId: id,
            messages: [{ kind: 'steering', text: 'never delivered' }]
          })
        )
        await adapter.cancel(id)
      },
      onEvent(listener) {
        listeners.add(listener)
        const off = adapter.onEvent(listener)
        return () => {
          listeners.delete(listener)
          off()
        }
      }
    }
    shell.dispose()
    shell = createShell({
      ...over(file),
      adapter: flushing,
      pickFolder: async () => picked
    })
    events = []
    shell.onEvent((event) => events.push(event))

    await shell.prompt(sessionId, 'hello')
    await settled()
    await shell.removeSession(sessionId)
    await settled()

    expect(types()).not.toContain('queue_flushed')
    expect((await shell.snapshot()).sessions).toEqual([])
  })

  // The bind is fine here and the adapter itself refuses the message, where
  // the contract is still never lost and never refused.
  it('does not lose a message the adapter refused to queue', async () => {
    const { sessionId } = await withSession()
    const refusing: ConversationAdapter = {
      ...adapter,
      async steer(): Promise<'queued' | 'idle'> {
        throw new Error('that run is gone')
      }
    }
    shell.dispose()
    shell = createShell({
      ...over(file),
      adapter: refusing,
      pickFolder: async () => picked
    })
    events = []
    shell.onEvent((event) => events.push(event))
    let steered: Promise<void> | undefined
    atFirstCall(() => {
      steered = shell.steer(sessionId, 'redirect')
    })

    await shell.prompt(sessionId, 'hello')
    await settled()

    await expect(steered).resolves.toBeUndefined()
    expect(
      events.some((event) => event.type === 'user_message' && event.text === 'redirect')
    ).toBe(true)
  })

  it('answers false for a dequeue of something no longer queued', async () => {
    const { sessionId } = await withSession()

    expect(await shell.dequeue(sessionId, 'steering', 'never queued')).toBe(false)
  })
})

describe('cancellation', () => {
  it('ends the live turn as cancelled and nothing else follows it', async () => {
    const { sessionId } = await withSession()
    shell.onEvent((event) => {
      if (event.type === 'text_delta') void shell.cancel(sessionId)
    })

    await shell.prompt(sessionId, 'hello')
    await settled()

    const own = types().filter((type) => type.startsWith('turn_'))
    expect(own).toEqual(['turn_started', 'turn_cancelled'])
  })

  it('touches only the session it names', async () => {
    const { workspaceId, sessionId: first } = await withSession()
    const second = await shell.createSession(workspaceId)
    shell.onEvent((event) => {
      if (event.type === 'text_delta' && event.sessionId === first) void shell.cancel(first)
    })

    await Promise.all([shell.prompt(first, 'one'), shell.prompt(second, 'two')])
    await settled()

    const terminalFor = (id: SessionId): string[] =>
      events
        .filter((event) => 'sessionId' in event && event.sessionId === id)
        .map((event) => event.type)
        .filter((type) => type === 'turn_ended' || type === 'turn_cancelled')

    expect(terminalFor(first)).toEqual(['turn_cancelled'])
    expect(terminalFor(second)).toEqual(['turn_ended'])
  })

  it('does nothing when the session has no live turn', async () => {
    const { sessionId } = await withSession()
    events.length = 0

    await shell.cancel(sessionId)
    await shell.cancel('nobody')

    expect(events).toEqual([])
  })

  it('does nothing when it loses the race with the turn\u2019s natural end', async () => {
    const { sessionId } = await withSession()
    await shell.prompt(sessionId, 'hello')
    await settled()
    const before = types()

    await shell.cancel(sessionId)
    await settled()

    expect(types()).toEqual(before)
  })

  it('leaves the session ready for the next prompt', async () => {
    const { sessionId } = await withSession()
    const stopEarly = shell.onEvent((event) => {
      if (event.type === 'text_delta') void shell.cancel(sessionId)
    })
    await shell.prompt(sessionId, 'hello')
    await settled()
    stopEarly()

    await shell.prompt(sessionId, 'do this instead')
    await settled()

    const transcript = await shell.transcript(sessionId)
    expect(transcript).toContainEqual({ kind: 'stopped' })
    expect(transcript).toContainEqual({ kind: 'user', text: 'do this instead' })
  })

  it('drops every live turn when the document that was watching goes away', async () => {
    const { workspaceId, sessionId: first } = await withSession()
    const second = await shell.createSession(workspaceId)
    void shell.prompt(first, 'one')
    void shell.prompt(second, 'two')

    shell.dispose()
    await settled()

    const snapshot = await shell.snapshot()
    expect(snapshot.sessions.every((session) => !session.working)).toBe(true)
  })
})

// A prompt accepted while its session is still binding shows as working before
// the adapter has heard of it, so everything that stops a turn has to land.
describe('a turn accepted while its session is still binding', () => {
  let sessionId: SessionId
  let release: () => void = () => {}
  let prompts: number

  async function gatedRelaunch(): Promise<void> {
    const created = await withSession()
    sessionId = created.sessionId
    shell.dispose()

    const inner = createFakeAdapter({ pauseMs: 0 })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    prompts = 0
    const gated: ConversationAdapter = {
      ...inner,
      async bind(request) {
        await gate
        return inner.bind(request)
      },
      async prompt(id, turnId, text) {
        prompts += 1
        return inner.prompt(id, turnId, text)
      }
    }
    shell = createShell({
      ...over(file),
      adapter: gated,
      pickFolder: async () => picked
    })
    events = []
    shell.onEvent((event) => events.push(event))
  }

  const terminals = (): string[] =>
    types().filter(
      (type) => type === 'turn_ended' || type === 'turn_cancelled' || type === 'turn_error'
    )

  it('is cancelled at once, and the adapter is never asked to run it', async () => {
    await gatedRelaunch()
    await shell.prompt(sessionId, 'hello')

    await shell.cancel(sessionId)

    // The stop does not wait on the bind it is stuck behind.
    expect(terminals()).toEqual(['turn_cancelled'])
    expect(sessionOf(await shell.snapshot(), sessionId)?.working).toBe(false)

    release()
    await settled()
    expect(prompts).toBe(0)
    expect(terminals()).toEqual(['turn_cancelled'])
  })

  it('is cancelled with the session that is removed, and says nothing after', async () => {
    await gatedRelaunch()
    await shell.prompt(sessionId, 'hello')

    await shell.removeSession(sessionId)
    release()
    await settled()

    // No turn run for an entry that has left the sidebar, and no phantom error
    // from an adapter asked to prompt a released session.
    expect(terminals()).toEqual(['turn_cancelled'])
    expect(prompts).toBe(0)
    expect((await shell.snapshot()).sessions).toEqual([])
  })

  // A failing bind behind a live turn is the one path where a steered message
  // has no queue to land in and no turn to fall back to.
  it('does not lose a message steered while the turn’s bind is failing', async () => {
    const created = await withSession()
    sessionId = created.sessionId
    shell.dispose()

    const inner = createFakeAdapter({ pauseMs: 0 })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const failing: ConversationAdapter = {
      ...inner,
      async bind() {
        await gate
        throw new Error('That conversation could not be opened.')
      }
    }
    shell = createShell({
      ...over(file),
      adapter: failing,
      pickFolder: async () => picked
    })
    events = []
    shell.onEvent((event) => events.push(event))

    await shell.prompt(sessionId, 'hello')
    const steered = shell.steer(sessionId, 'redirect')
    release()

    // Never refused: the steer resolves rather than rejecting with the bind's
    // failure…
    await expect(steered).resolves.toBeUndefined()
    await settled()

    // …and never lost: the text either fell back to a prompt of its own or was
    // handed back to the composer.
    const announced = events.some(
      (event) => event.type === 'user_message' && event.text === 'redirect'
    )
    const flushed = events.some(
      (event) =>
        event.type === 'queue_flushed' &&
        event.messages.some((message) => message.text === 'redirect')
    )
    expect(announced || flushed).toBe(true)
  })

  it('is cancelled by a reset rather than run under the fresh conversation', async () => {
    await gatedRelaunch()
    await shell.prompt(sessionId, 'hello')

    const reset = shell.resetSession(sessionId)
    release()
    await reset
    await settled()

    // A reset cancels live work, so the pre-reset turn is not a normal end.
    expect(terminals()).toEqual(['turn_cancelled'])
    expect(prompts).toBe(0)
    expect((await shell.snapshot()).sessions.map((session) => session.id)).toEqual([sessionId])
  })
})

describe('models and thinking levels', () => {
  it('reports what the adapter can reach and nothing else', async () => {
    expect(await shell.listModels()).toEqual([
      {
        id: 'fake/deterministic',
        label: 'Fake · deterministic (no network, no cost)',
        thinkingLevels: ['off', 'low', 'high']
      }
    ])
  })

  it('remembers the last selection and starts the next session on it', async () => {
    const { workspaceId, sessionId } = await withSession()

    await shell.setModel(sessionId, 'fake/deterministic')
    const next = await shell.createSession(workspaceId)

    expect(sessionOf(await shell.snapshot(), next)?.model).toBe('fake/deterministic')
  })

  it('keeps the level on the session and refuses one the model lacks', async () => {
    const { sessionId } = await withSession()

    await shell.setThinkingLevel(sessionId, 'high')
    expect(sessionOf(await shell.snapshot(), sessionId)?.thinkingLevel).toBe('high')

    await expect(shell.setThinkingLevel(sessionId, 'xhigh')).rejects.toThrow()
  })

  it('refuses a change while that session is working', async () => {
    const { sessionId } = await withSession()
    const turn = shell.prompt(sessionId, 'hello')

    await expect(shell.setThinkingLevel(sessionId, 'high')).rejects.toThrow(/working/i)
    await expect(shell.setModel(sessionId, 'fake/deterministic')).rejects.toThrow(/working/i)

    await turn
  })
})

describe('a relaunch', () => {
  it('restores the sidebar and rebinds a session the first time it is read', async () => {
    const { sessionId } = await withSession()
    await shell.prompt(sessionId, 'said before the relaunch')
    await settled()
    shell.dispose()

    // A second shell over the same file: the sidebar is the store's, and what
    // the conversation holds is the adapter's.
    build()
    const snapshot = await shell.snapshot()

    expect(snapshot.sessions.map((session) => session.id)).toEqual([sessionId])
    expect(snapshot.activeSessionId).toBe(sessionId)
    // The fake adapter's history is in memory, so a relaunch honestly finds an
    // empty conversation behind the entry that survived.
    expect(await shell.transcript(sessionId)).toEqual([])
    expect(sessionOf(await shell.snapshot(), sessionId)?.model).toBe('fake/deterministic')
  })
})

// The fake adapter is built with no pause, so one macrotask turn is past its
// whole script however long that grows.
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
