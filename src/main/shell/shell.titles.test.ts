// @vitest-environment node
//
// When a session is titled is the shell's business; writing the title is the
// adapter's, so these run against the fake adapter and cost nothing.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConversationAdapter } from '../../shared/agent/adapter'
import { createFakeAdapter, scaleUsage } from '../../shared/agent/fake-adapter'
import type { SessionId, ShellSnapshot } from '../../shared/agent/port'
import { createPanelModel } from '../panel/model'
import { storePanelPersistence } from '../panel/store-persistence'
import { createShell, type Shell } from './shell'
import { createShellStore, type ShellStore } from './store'

const WORKSPACE = '/repos/crucible'

let directory: string
let file: string
let store: ShellStore
let adapter: ConversationAdapter
let shell: Shell
let failures: unknown[]

/** The fake adapter, with whatever a test needs of its titler replaced. */
function build(titler?: Partial<Pick<ConversationAdapter, 'titleConversation'>>): void {
  store = createShellStore(file)
  adapter = { ...createFakeAdapter({ pauseMs: 0 }), ...titler }
  failures = []
  shell = createShell({
    store,
    panel: createPanelModel({ persistence: storePanelPersistence(store) }),
    adapter,
    flavor: 'fake',
    pickFolder: async () => WORKSPACE,
    onTitlingFailure: (cause) => failures.push(cause)
  })
}

async function withSession(): Promise<SessionId> {
  const workspaceId = await shell.addWorkspace()
  if (workspaceId === null) throw new Error('the picker was supposed to answer')
  return shell.createSession(workspaceId)
}

const sessionOf = (snapshot: ShellSnapshot, id: SessionId) =>
  snapshot.sessions.find((session) => session.id === id)

/** The fake adapter runs its whole script inside one macrotask. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'crucible-titles-'))
  file = join(directory, 'shell-state.json')
  build()
})

afterEach(() => {
  shell.dispose()
  rmSync(directory, { recursive: true, force: true })
})

describe('when a session gets its title', () => {
  it('has none at all until something has been said', async () => {
    const sessionId = await withSession()

    expect(sessionOf(await shell.snapshot(), sessionId)?.title).toBeUndefined()
  })

  it('is titled from the turn it starts, not only once it ends', async () => {
    const sessionId = await withSession()

    const turn = shell.prompt(sessionId, 'rebuild the composer footer from the mock')
    await settled()
    const titled = sessionOf(await shell.snapshot(), sessionId)?.title

    expect(titled).toBe('rebuild the composer footer from the mock')
    await turn
  })

  it('refreshes as later turns land', async () => {
    const sessionId = await withSession()
    await shell.prompt(sessionId, 'first, the footer')
    await settled()

    await shell.prompt(sessionId, 'now the model ring, in the same session')
    await settled()

    expect(sessionOf(await shell.snapshot(), sessionId)?.title).toBe(
      'now the model ring, in the same session'
    )
  })

  it('carries the title in the snapshot and keeps it across a relaunch', async () => {
    const sessionId = await withSession()
    await shell.prompt(sessionId, 'name this session please')
    await settled()
    shell.dispose()

    // A second shell over the same file, and an adapter that would refuse to
    // title anything: what the sidebar shows is what was stored.
    build({
      titleConversation: () => Promise.reject(new Error('no titler in this launch'))
    })
    const restored = sessionOf(await shell.snapshot(), sessionId)

    expect(restored?.title).toBe('name this session please')
    expect(restored?.lastActivityAt).not.toBeUndefined()
  })

  it('coalesces triggers that arrive while a pass is under way', async () => {
    let asked = 0
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    build({
      titleConversation: async () => {
        asked += 1
        await held
        return { title: `pass ${asked}` }
      }
    })
    const sessionId = await withSession()

    // The turn's start and its end are two triggers; the second lands while
    // the first pass is still in flight.
    await shell.prompt(sessionId, 'say something')
    await settled()
    expect(asked).toBe(1)

    release?.()
    await settled()

    // One follow-up pass, however many triggers arrived during the first.
    expect(asked).toBe(2)
  })

  it('keeps the last good title when a pass fails, and says so only to the log', async () => {
    let refuse = false
    build({
      titleConversation: async () => {
        if (refuse) throw new Error('the titler could not be reached')
        return { title: 'a title that landed' }
      }
    })
    const sessionId = await withSession()
    await shell.prompt(sessionId, 'first')
    await settled()

    refuse = true
    await shell.prompt(sessionId, 'second')
    await settled()

    expect(sessionOf(await shell.snapshot(), sessionId)?.title).toBe('a title that landed')
    expect(failures.length).toBeGreaterThan(0)
  })

  it('changes nothing when a pass answers with nothing', async () => {
    build({ titleConversation: async () => undefined })
    const sessionId = await withSession()

    await shell.prompt(sessionId, 'say something')
    await settled()

    expect(sessionOf(await shell.snapshot(), sessionId)?.title).toBeUndefined()
  })

  it('goes back to untitled when the session is reset', async () => {
    const sessionId = await withSession()
    await shell.prompt(sessionId, 'the conversation this title described')
    await settled()

    await shell.resetSession(sessionId)

    expect(sessionOf(await shell.snapshot(), sessionId)?.title).toBeUndefined()
    expect(store.session(sessionId)?.titlingSpend).toBeUndefined()
  })

  // A pass reads the conversation as it was when it started; a reset replaces
  // that conversation underneath it.
  it('never lets a pass in flight name the conversation that replaced it', async () => {
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    build({
      titleConversation: async () => {
        await held
        return { title: 'named the conversation that is gone' }
      }
    })
    const sessionId = await withSession()
    await shell.prompt(sessionId, 'something worth naming')

    await shell.resetSession(sessionId)
    release?.()
    await settled()

    expect(sessionOf(await shell.snapshot(), sessionId)?.title).toBeUndefined()
  })

  it('titles a resumed conversation that arrived without one', async () => {
    const sessionId = await withSession()
    await shell.prompt(sessionId, 'said in the conversation being resumed')
    await settled()
    const workspaceId = store.session(sessionId)?.workspaceId ?? ''
    const [found] = await shell.searchHistory(workspaceId, 'said in the conversation')
    await shell.removeSession(sessionId)

    const resumed = await shell.resumeSession(workspaceId, found?.ref ?? '')
    await settled()

    expect(sessionOf(await shell.snapshot(), resumed)?.title).toBe(
      'said in the conversation being resumed'
    )
  })
})

describe('what titling costs', () => {
  /** A titler that spends real money, so the fold is genuinely exercised. */
  function withSpend(cost: number): void {
    build({
      titleConversation: async () => ({
        title: 'a paid title',
        spend: { tokens: 320, cost }
      })
    })
  }

  it('adds up over passes and lands on the session cost chip', async () => {
    withSpend(0.01)
    const sessionId = await withSession()

    await shell.prompt(sessionId, 'one turn')
    await settled()

    // The conversation's own dollars, plus two passes of a cent each.
    const usage = sessionOf(await shell.snapshot(), sessionId)?.usage
    expect(usage?.cost).toBeCloseTo(0.84 + 0.02, 5)
  })

  it('shows a dash while the conversation has reported nothing', async () => {
    withSpend(0.01)
    const sessionId = await withSession()

    // A rebind with no stored title is a titling trigger of its own, so this
    // session has been paid for without a single conversation number.
    shell.dispose()
    withSpend(0.01)
    await shell.transcript(sessionId)
    await settled()

    expect(store.session(sessionId)?.titlingSpend).toBeCloseTo(0.01, 5)
    // Ignorance is not under-reporting: the chip keeps its dash.
    expect(sessionOf(await shell.snapshot(), sessionId)?.usage).toBeUndefined()
  })

  it('rides in the usage total without disturbing the four lines', async () => {
    withSpend(0.01)
    const sessionId = await withSession()
    await shell.prompt(sessionId, 'one turn')
    await settled()

    const summed = await shell.sessionUsage(sessionId)
    const conversation = scaleUsage(1)

    expect(summed?.input).toEqual(conversation.input)
    expect(summed?.totalCost).toBeCloseTo(conversation.totalCost + 0.02, 5)
  })
})
