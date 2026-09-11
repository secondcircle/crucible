// @vitest-environment node
//
// The running flavor is always 'fake'; 'sdk' is only a word written into the
// store, so no SDK adapter is ever constructed here.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  BindRequest,
  ConversationAdapter,
  UsageRequest
} from '../../shared/agent/adapter'
import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import type { SessionId } from '../../shared/agent/port'
import { createPanelModel, type PanelModel } from '../panel/model'
import { storePanelPersistence } from '../panel/store-persistence'
import { createQuestionsModel } from '../questions/model'
import { createShell, type Shell } from './shell'
import { createShellStore, type StoredSession } from './store'

// What never reached the adapter is not observable through the port, so this
// wrapper keeps what did.
interface Recorder {
  readonly binds: BindRequest[]
  readonly usages: UsageRequest[]
  readonly compared: string[]
}

function recording(inner: ConversationAdapter, into: Recorder): ConversationAdapter {
  return {
    ...inner,
    bind(request: BindRequest) {
      into.binds.push(request)
      return inner.bind(request)
    },
    sessionUsage(request: UsageRequest) {
      into.usages.push(request)
      return inner.sessionUsage(request)
    },
    sameConversation(token: string, ref: string): boolean {
      into.compared.push(token)
      return inner.sameConversation(token, ref)
    }
  }
}

let directory: string
let file: string
let inner: ConversationAdapter
let record: Recorder
let panel: PanelModel
let shell: Shell

function build(): void {
  record = { binds: [], usages: [], compared: [] }
  const store = createShellStore(file)
  panel = createPanelModel({ persistence: storePanelPersistence(store) })
  shell = createShell({
    store,
    panel,
    questions: createQuestionsModel(),
    adapter: recording(inner, record),
    flavor: 'fake',
    pickFolder: async () => directory
  })
}

// The edit stands in for a store file as some earlier launch left it.
function relaunch(edit: (session: Record<string, unknown>) => void = () => {}): void {
  shell.dispose()
  for (const session of createShellStore(file).state.sessions) inner.release(session.id)
  const written = JSON.parse(readFileSync(file, 'utf8')) as {
    sessions: Record<string, unknown>[]
  }
  written.sessions.forEach(edit)
  writeFileSync(file, JSON.stringify(written), 'utf8')
  build()
}

const foreign = (session: Record<string, unknown>): void => {
  session.tokenFlavor = 'sdk'
}

const unflavored = (session: Record<string, unknown>): void => {
  delete session.tokenFlavor
}

async function withSession(): Promise<{ workspaceId: string; sessionId: SessionId }> {
  const workspaceId = await shell.addWorkspace()
  if (workspaceId === null) throw new Error('the picker was supposed to answer')
  const sessionId = await shell.createSession(workspaceId)
  return { workspaceId, sessionId }
}

/** Read from the file, since the live store's state can differ from what it wrote. */
const stored = (id: SessionId): StoredSession | undefined => createShellStore(file).session(id)

const bindsFor = (id: SessionId): BindRequest[] =>
  record.binds.filter((request) => request.sessionId === id)

/** The fake adapter is built with no pause, so one macrotask is a whole turn. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'crucible-flavor-'))
  file = join(directory, 'state', 'shell-state.json')
  inner = createFakeAdapter({ pauseMs: 0 })
  build()
})

afterEach(() => {
  shell.dispose()
  rmSync(directory, { recursive: true, force: true })
})

describe('a token minted by another flavor', () => {
  it('is never offered to the adapter, and the session binds fresh', async () => {
    const { sessionId } = await withSession()
    await shell.prompt(sessionId, 'said under the flavor that minted it')
    await settled()
    const stale = stored(sessionId)?.token
    expect(stale).toBeDefined()

    relaunch(foreign)
    const transcript = await shell.transcript(sessionId)

    expect(bindsFor(sessionId)).toHaveLength(1)
    expect(bindsFor(sessionId)[0].token).toBeUndefined()
    expect(record.binds.every((request) => request.token !== stale)).toBe(true)
    expect(transcript).toEqual([])
  })

  it('keeps the sidebar identity and is replaced by what the bind reported', async () => {
    const { sessionId } = await withSession()
    const before = stored(sessionId)
    await shell.prompt(sessionId, 'before the foreign launch')
    await settled()
    const stale = stored(sessionId)?.token

    relaunch(foreign)
    await shell.transcript(sessionId)
    const after = stored(sessionId)

    expect((await shell.snapshot()).sessions.map((session) => session.id)).toEqual([sessionId])
    expect(after?.createdAt).toBe(before?.createdAt)
    expect(after?.workspaceId).toBe(before?.workspaceId)
    expect(after?.token).toBeDefined()
    expect(after?.token).not.toBe(stale)
    expect(after?.tokenFlavor).toBe('fake')
  })

  it('resolves the mismatch once rather than binding fresh every launch', async () => {
    const { sessionId } = await withSession()
    await shell.prompt(sessionId, 'lost with the foreign conversation')
    await settled()

    relaunch(foreign)
    await shell.transcript(sessionId)
    await shell.prompt(sessionId, 'said after the fresh bind')
    await settled()
    const minted = stored(sessionId)?.token

    relaunch()
    const transcript = await shell.transcript(sessionId)

    expect(bindsFor(sessionId)[0].token).toBe(minted)
    expect(transcript).toContainEqual({ kind: 'user', text: 'said after the fresh bind' })
    expect(stored(sessionId)?.tokenFlavor).toBe('fake')
  })

  it('leaves the old conversation where its own adapter keeps it', async () => {
    const { workspaceId, sessionId } = await withSession()
    await shell.prompt(sessionId, 'not deleted by the mismatch')
    await settled()

    relaunch(foreign)
    await shell.transcript(sessionId)

    expect(await shell.searchHistory(workspaceId, 'not deleted by the mismatch')).toHaveLength(1)
  })

  it('resets the panel with the conversation whose agent curated it', async () => {
    const { sessionId } = await withSession()
    const exhibit = join(directory, 'plan.md')
    writeFileSync(exhibit, '# the plan', 'utf8')
    panel.show(sessionId, directory, exhibit, 'the plan')
    expect(stored(sessionId)?.panel?.tabs).toHaveLength(1)

    relaunch(foreign)
    await shell.transcript(sessionId)
    const snapshot = await shell.snapshot()

    expect(snapshot.sessions.find((session) => session.id === sessionId)?.panel).toBeUndefined()
    expect(stored(sessionId)?.panel?.tabs).toEqual([])
  })

  it('is never offered to the usage request either', async () => {
    const { sessionId } = await withSession()
    await shell.prompt(sessionId, 'usage worth reporting')
    await settled()
    const stale = stored(sessionId)?.token

    relaunch(foreign)
    // Unbound on purpose: the usage path is the one that reaches for a stored
    // token without a bind behind it.
    const usage = await shell.sessionUsage(sessionId)

    expect(record.usages).toHaveLength(1)
    expect(record.usages[0].token).toBeUndefined()
    expect(record.usages.every((request) => request.token !== stale)).toBe(true)
    expect(usage).toBeUndefined()
  })

  it('is never offered to the resume dedupe, so the resume adds an entry', async () => {
    const { workspaceId, sessionId } = await withSession()
    await shell.prompt(sessionId, 'the one conversation')
    await settled()
    const stale = stored(sessionId)?.token

    relaunch(foreign)
    const [match] = await shell.searchHistory(workspaceId, 'the one conversation')
    // The fake adapter's refs are its tokens, so this is the strongest form of
    // the case: the strings are equal and the flavors are not.
    expect(match.ref).toBe(stale)
    const resumed = await shell.resumeSession(workspaceId, match.ref)

    expect(record.compared).toEqual([])
    expect(resumed).not.toBe(sessionId)
    expect((await shell.snapshot()).sessions).toHaveLength(2)
    expect(stored(resumed)?.tokenFlavor).toBe('fake')
  })
})

describe('a token with no flavor recorded', () => {
  it('binds fresh once and is stamped from then on', async () => {
    const { sessionId } = await withSession()
    await shell.prompt(sessionId, 'said before the contract existed')
    await settled()

    relaunch(unflavored)
    const afterFirst = await shell.transcript(sessionId)
    await shell.prompt(sessionId, 'said after the stamp')
    await settled()

    expect(bindsFor(sessionId)[0].token).toBeUndefined()
    expect(afterFirst).toEqual([])
    expect(stored(sessionId)?.tokenFlavor).toBe('fake')

    relaunch()
    const afterSecond = await shell.transcript(sessionId)

    expect(bindsFor(sessionId)[0].token).toBe(stored(sessionId)?.token)
    expect(afterSecond).toContainEqual({ kind: 'user', text: 'said after the stamp' })
  })
})

describe('a token of the running flavor', () => {
  it('is offered to the bind and restores the conversation', async () => {
    const { sessionId } = await withSession()
    await shell.prompt(sessionId, 'said before the relaunch')
    await settled()
    const token = stored(sessionId)?.token

    relaunch()
    const transcript = await shell.transcript(sessionId)

    expect(bindsFor(sessionId)).toHaveLength(1)
    expect(bindsFor(sessionId)[0].token).toBe(token)
    expect(transcript).toContainEqual({ kind: 'user', text: 'said before the relaunch' })
    expect(stored(sessionId)?.tokenFlavor).toBe('fake')
  })

  it('rides along with the usage request for an unbound session', async () => {
    const { sessionId } = await withSession()
    await shell.prompt(sessionId, 'usage worth reporting')
    await settled()
    const token = stored(sessionId)?.token

    relaunch()
    const usage = await shell.sessionUsage(sessionId)

    expect(record.usages[0].token).toBe(token)
    expect(usage?.totalTokens).toBeGreaterThan(0)
  })

  it('is what the resume dedupe compares, so the entry is activated', async () => {
    const { workspaceId, sessionId } = await withSession()
    await shell.prompt(sessionId, 'the one conversation')
    await settled()
    const token = stored(sessionId)?.token

    relaunch()
    const [match] = await shell.searchHistory(workspaceId, 'the one conversation')
    const resumed = await shell.resumeSession(workspaceId, match.ref)

    expect(record.compared).toContain(token)
    expect(resumed).toBe(sessionId)
    expect((await shell.snapshot()).sessions).toHaveLength(1)
  })
})
