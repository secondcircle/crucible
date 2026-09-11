// @vitest-environment node
//
// What a session's cache miss becomes: one ledger line with the identity only
// main holds, and one port event for the surfaces. Driven through the fake
// adapter's scripted miss, so no SDK session and no real ledger file is
// involved — the recorder is a stand-in that keeps what it was handed.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeAdapter, FAKE_CACHE_MISS } from '../../shared/agent/fake-adapter'
import type { PortEvent, SessionId } from '../../shared/agent/port'
import type { CacheRecorder, RecordedCacheMiss } from '../cache/ledger'
import { createPanelModel } from '../panel/model'
import { storePanelPersistence } from '../panel/store-persistence'
import { createQuestionsModel } from '../questions/model'
import { createShell, type Shell } from './shell'
import { createShellStore, type ShellStore } from './store'

const WORKSPACE = '/repos/crucible'

/** The prompt the fake adapter scripts a miss for. */
const ASKING = 'show me what a cache miss looks like'

let directory: string
let store: ShellStore
let shell: Shell
let written: RecordedCacheMiss[]
let events: PortEvent[]

function build(retention: '5m' | '1h' = '5m'): void {
  store = createShellStore(join(directory, 'shell-state.json'))
  written = []
  events = []
  const recorder: CacheRecorder = {
    retention,
    ledgerPath: join(directory, 'cache-misses.jsonl'),
    append: async (miss) => {
      written.push(miss)
    }
  }
  shell = createShell({
    store,
    panel: createPanelModel({ persistence: storePanelPersistence(store) }),
    questions: createQuestionsModel(),
    adapter: createFakeAdapter({ pauseMs: 0 }),
    flavor: 'fake',
    pickFolder: async () => WORKSPACE,
    cache: recorder
  })
  shell.onEvent((event) => events.push(event))
}

async function withSession(): Promise<SessionId> {
  const workspaceId = await shell.addWorkspace()
  if (workspaceId === null) throw new Error('the picker was supposed to answer')
  return shell.createSession(workspaceId)
}

/** The fake adapter runs its whole script inside one macrotask. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'crucible-shell-cache-'))
  build()
})

afterEach(() => {
  shell.dispose()
  rmSync(directory, { recursive: true, force: true })
})

describe('recording a session\u2019s cache misses', () => {
  it('writes one ledger line carrying the session, its title and the workspace', async () => {
    const sessionId = await withSession()

    await shell.prompt(sessionId, ASKING)
    await settled()

    expect(written).toHaveLength(1)
    const [entry] = written
    expect(entry.source).toEqual({
      kind: 'session',
      sessionId,
      // The title as it stood at the moment of the miss.
      title: ASKING,
      // The workspace path, never a worktree.
      workspace: WORKSPACE
    })
    expect(entry.provider).toBe(FAKE_CACHE_MISS.provider)
    expect(entry.model).toBe(FAKE_CACHE_MISS.model)
    expect(entry.tokensRebilled).toBe(FAKE_CACHE_MISS.tokensRebilled)
    expect(entry.dollarsRebilled).toBe(FAKE_CACHE_MISS.dollarsRebilled)
    expect(entry.gapMs).toBe(FAKE_CACHE_MISS.gapMs)
    expect(entry.changed).toEqual(FAKE_CACHE_MISS.changed)
    expect(new Date(entry.at).getTime()).not.toBeNaN()
    // No cause anywhere, and nothing naming a culprit.
    expect(Object.keys(entry)).not.toContain('cause')
  })

  it('forwards the same facts to the renderer, with the retention in force', async () => {
    build('1h')
    const sessionId = await withSession()

    const turnId = await shell.prompt(sessionId, ASKING)
    await settled()

    const announced = events.filter((event) => event.type === 'cache_miss')
    expect(announced).toHaveLength(1)
    expect(announced[0]).toEqual({
      type: 'cache_miss',
      sessionId,
      turnId,
      miss: {
        tokensRebilled: FAKE_CACHE_MISS.tokensRebilled,
        dollarsRebilled: FAKE_CACHE_MISS.dollarsRebilled,
        gapMs: FAKE_CACHE_MISS.gapMs,
        modelChanged: 'no',
        thinkingChanged: 'no',
        jump: 'no',
        // The setting recorded per entry, because it is what the whole
        // experiment exists to measure.
        retention: '1h'
      }
    })
  })

  it('marks the miss of a send the person chose with the price in front of them', async () => {
    const sessionId = await withSession()

    await shell.prompt(sessionId, ASKING, undefined, { expiryAcknowledged: true })
    await settled()

    // Recorded whole, and named for what it was: a choice, not a surprise.
    expect(written).toHaveLength(1)
    expect(written[0]).toEqual(expect.objectContaining({ acknowledged: true }))
    expect(written[0]?.dollarsRebilled).toBe(FAKE_CACHE_MISS.dollarsRebilled)
  })

  it('marks nothing for an ordinary send, and nothing after the acknowledged turn', async () => {
    const sessionId = await withSession()

    await shell.prompt(sessionId, ASKING, undefined, { expiryAcknowledged: true })
    await settled()
    await shell.prompt(sessionId, ASKING)
    await settled()

    expect(written).toHaveLength(2)
    expect(written[0]).toEqual(expect.objectContaining({ acknowledged: true }))
    // The choice covered one send; the next turn's miss is nobody's choice.
    expect(written[1]).not.toHaveProperty('acknowledged')
  })

  it('folds the conversation\u2019s totals into the session state', async () => {
    const sessionId = await withSession()

    await shell.prompt(sessionId, ASKING)
    await settled()

    const session = (await shell.snapshot()).sessions.find(
      (candidate) => candidate.id === sessionId
    )
    expect(session?.cacheMisses).toEqual({ count: 1, dollars: 0.62 })
    // Beside the money rather than inside it: the usage line is unchanged.
    expect(session?.usage?.cost).toBeGreaterThan(0)
  })

  it('folds what the conversation has cached in, stamped with the setting', async () => {
    build('1h')
    const sessionId = await withSession()

    await shell.prompt(sessionId, 'let the cache expire on this one')
    await settled()

    const session = (await shell.snapshot()).sessions.find(
      (candidate) => candidate.id === sessionId
    )
    // The adapter knows the tokens and what they cost; the retention is
    // main's, exactly as it is on a recorded miss, so nothing on screen can
    // disagree with what was written down.
    expect(session?.cachedPrefix).toMatchObject({ tokens: 110_000, retention: '1h' })
    expect(Date.parse(session?.cachedPrefix?.at ?? '')).not.toBeNaN()
  })

  it('says nothing about a prefix a fresh session has not built yet', async () => {
    const sessionId = await withSession()

    const session = (await shell.snapshot()).sessions.find(
      (candidate) => candidate.id === sessionId
    )
    expect(session?.cachedPrefix).toBeUndefined()
  })

  it('records nothing at all for a prompt that paid for nothing', async () => {
    const sessionId = await withSession()

    await shell.prompt(sessionId, 'an ordinary prompt with no scripted miss')
    await settled()

    expect(written).toEqual([])
    expect(events.some((event) => event.type === 'cache_miss')).toBe(false)
  })
})
