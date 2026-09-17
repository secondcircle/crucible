// @vitest-environment node
//
// When a conversation compacts, and what the rest of the app is told when it
// does. Driven through the fake adapter, which carries out a real compaction
// from a canned reply, so nothing here constructs an SDK session.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterEventListener, ConversationAdapter } from '../../shared/agent/adapter'
import { createFakeAdapter, FAKE_TRAJECTORY_SUMMARY } from '../../shared/agent/fake-adapter'
import type { PortEvent, SessionId } from '../../shared/agent/port'
import { DEFAULT_COMPACTION_SETTINGS, MIN_THRESHOLD_K } from '../../shared/compaction/settings'
import type { CacheRecorder, RecordedCacheMiss } from '../cache/ledger'
import { createPanelModel } from '../panel/model'
import { storePanelPersistence } from '../panel/store-persistence'
import { createQuestionsModel } from '../questions/model'
import { createShell, type Shell } from './shell'
import { createShellStore, type ShellStore } from './store'

const WORKSPACE = '/repos/crucible'

// Big enough that the conversation is worth compacting after one turn: past
// the lowest threshold the field accepts, and past twice what a compaction
// leaves behind. The fake counts a prompt's own characters towards the
// context.
const LONG = `a long message ${'x'.repeat(440_000)}`

/** The prompt the fake adapter scripts a cache miss for. */
const MISSING = 'show me what a cache miss looks like'

let directory: string
let store: ShellStore
let shell: Shell
let events: PortEvent[]
let written: RecordedCacheMiss[]
let clock: number
let armed: { at: number; run: () => void }[]

/** Hand-cranked, so the fifty-minute rule is tested at its own minute. */
function advance(ms: number): void {
  clock += ms
  for (const timer of [...armed]) {
    if (timer.at > clock) continue
    armed.splice(armed.indexOf(timer), 1)
    timer.run()
  }
}

function build(
  retention: '5m' | '1h' = '1h',
  wrap: (adapter: ConversationAdapter) => ConversationAdapter = (adapter) => adapter
): void {
  store = createShellStore(join(directory, 'shell-state.json'))
  events = []
  written = []
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
    adapter: wrap(createFakeAdapter({ pauseMs: 0 })),
    flavor: 'fake',
    pickFolder: async () => WORKSPACE,
    cache: recorder,
    compactionTimers: {
      now: () => clock,
      setTimer: (run, ms) => {
        const timer = { at: clock + ms, run }
        armed.push(timer)
        return timer
      },
      clearTimer: (handle) => {
        const at = armed.indexOf(handle as { at: number; run: () => void })
        if (at !== -1) armed.splice(at, 1)
      }
    }
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
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function turn(sessionId: SessionId, text: string): Promise<void> {
  await shell.prompt(sessionId, text)
  await settled()
}

// A session with a conversation big enough to be worth compacting and with a
// user boundary behind the newest turn to cut at.
async function grown(): Promise<SessionId> {
  const sessionId = await withSession()
  await turn(sessionId, LONG)
  await turn(sessionId, 'a short follow-up')
  return sessionId
}

/** Everything said in the conversation, so far, as one string. */
async function said(sessionId: SessionId): Promise<string> {
  return (await shell.transcript(sessionId))
    .map((item) => (item.kind === 'user' ? item.text : ''))
    .join('\n')
}

function compactions(): Extract<PortEvent, { type: 'compacted' }>[] {
  return events.filter(
    (event): event is Extract<PortEvent, { type: 'compacted' }> => event.type === 'compacted'
  )
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'crucible-shell-compaction-'))
  // The fake stamps its cached prefix with the wall clock, and the idle rule
  // counts from that stamp: the two have to be the same clock.
  clock = Date.now()
  armed = []
  build()
})

afterEach(() => {
  shell.dispose()
  rmSync(directory, { recursive: true, force: true })
})

describe('the setting across the port', () => {
  it('is on at 200k until somebody changes it', async () => {
    await expect(shell.compactionSettings()).resolves.toEqual(DEFAULT_COMPACTION_SETTINGS)
  })

  it('keeps what was set, on this machine rather than on a workspace', async () => {
    await shell.setCompactionSettings({ enabled: false, thresholdK: 120 })

    await expect(shell.compactionSettings()).resolves.toEqual({
      enabled: false,
      thresholdK: 120
    })
    expect(store.state.compaction).toEqual({ enabled: false, thresholdK: 120 })
  })

  it('clamps a threshold below the smallest one that compacts anything', async () => {
    await shell.setCompactionSettings({ enabled: true, thresholdK: 2 })

    await expect(shell.compactionSettings()).resolves.toEqual({
      enabled: true,
      thresholdK: MIN_THRESHOLD_K
    })
  })
})

describe('the threshold trigger', () => {
  it('compacts once the conversation crosses the setting', async () => {
    const sessionId = await grown()
    await shell.setCompactionSettings({ enabled: true, thresholdK: MIN_THRESHOLD_K })
    await turn(sessionId, 'and the next thing')

    const [compacted] = compactions()
    expect(compacted?.record.trigger).toBe('threshold')
    expect(compacted?.record.tokensBefore).toBeGreaterThan(compacted?.record.tokensAfter ?? 0)
    expect(compacted?.text).toContain(FAKE_TRAJECTORY_SUMMARY)
    // What the person said is in the block whole. It is the one thing the
    // model cannot get back afterwards: the transcript still shows it and the
    // session file still holds it, and the model can read neither.
    expect(compacted?.text).toContain(LONG)
  })

  // The compaction reports the conversation's new size the moment it lands,
  // and that report is not a new request: a conversation still over the
  // threshold afterwards has nothing to gain from compacting again, and a
  // build that let it would spin.
  it('compacts once, and not again on the size the compaction itself reports', async () => {
    const sessionId = await grown()
    await shell.setCompactionSettings({ enabled: true, thresholdK: MIN_THRESHOLD_K })
    // One turn larger than the threshold, so the recent span the compaction
    // keeps is over it too: the size the compaction reports on landing would
    // call for another compaction, which would keep nothing new and report the
    // same size again.
    await turn(sessionId, LONG)
    await settled()
    await settled()

    const [compacted] = compactions()
    expect(compacted?.record.tokensAfter).toBeGreaterThan(MIN_THRESHOLD_K * 1_000)
    expect(compactions()).toHaveLength(1)
  })

  // And not on the turns after it either. A conversation whose own compaction
  // could not get it under the threshold is not one a second pass can help:
  // it would keep the same recent span, write the same skeleton and land at
  // the same size. Every repeat is a whole-context request and a prefix
  // written again from zero, which is the bill the idle rule exists to
  // prevent, arriving through the other trigger.
  it('leaves the conversation alone on the turns after a compaction that landed over it', async () => {
    const sessionId = await grown()
    await shell.setCompactionSettings({ enabled: true, thresholdK: MIN_THRESHOLD_K })
    await turn(sessionId, LONG)
    await settled()
    expect(compactions()[0]?.record.tokensAfter).toBeGreaterThan(MIN_THRESHOLD_K * 1_000)

    await turn(sessionId, 'one more turn')
    await turn(sessionId, 'and another')

    expect(compactions()).toHaveLength(1)
  })

  // A conversation of one turn has no user boundary to cut at, so the
  // compaction its size asks for writes nothing. Nothing was rewritten, so
  // nothing is held against it: the turn that gives it a boundary compacts.
  // Remembering the attempt as a result would leave the conversation
  // uncompactable for good, and at the window edge that is a session that
  // errors on every send.
  it('compacts a conversation whose first attempt had nothing to cut at', async () => {
    const sessionId = await withSession()
    await shell.setCompactionSettings({ enabled: true, thresholdK: MIN_THRESHOLD_K })
    await turn(sessionId, LONG)
    await settled()
    expect(compactions()).toEqual([])

    await turn(sessionId, 'a short follow-up')
    await settled()

    expect(compactions()).toHaveLength(1)
    expect(compactions()[0]?.record.trigger).toBe('threshold')
  })

  it('leaves a conversation under the setting alone', async () => {
    const sessionId = await grown()
    await turn(sessionId, 'and the next thing')

    expect(compactions()).toEqual([])
  })

  // The switch governs the threshold; the window edge is the last resort, and
  // a conversation there compacts rather than erroring on every send.
  it('still compacts at the model’s window with the switch off', async () => {
    const sessionId = await grown()
    await shell.setCompactionSettings({ enabled: false, thresholdK: 200 })
    // The fake's window is 200k, so one more message this size reaches it.
    await turn(sessionId, 'y'.repeat(600_000))

    expect(compactions()[0]?.record.trigger).toBe('windowEdge')
  })

  it('says nothing to the agent and starts no turn of its own', async () => {
    const sessionId = await grown()
    await shell.setCompactionSettings({ enabled: true, thresholdK: MIN_THRESHOLD_K })
    await turn(sessionId, 'and the next thing')

    const after = events.slice(events.findIndex((event) => event.type === 'compacted'))
    expect(after.some((event) => event.type === 'turn_started')).toBe(false)
    const session = (await shell.snapshot()).sessions[0]
    expect(session?.working).toBe(false)
    expect(session?.compacting).toBeUndefined()
  })

  it('leaves the compacted-away messages in the transcript, with the block after them', async () => {
    const sessionId = await grown()
    await shell.setCompactionSettings({ enabled: true, thresholdK: MIN_THRESHOLD_K })
    await turn(sessionId, 'and the next thing')

    const items = await shell.transcript(sessionId)
    expect(items[0]).toEqual({ kind: 'user', text: LONG })
    expect(items.at(-1)?.kind).toBe('summary')
  })
})

describe('the idle trigger', () => {
  it('compacts fifty minutes after the last request, with the cache still warm', async () => {
    await grown()

    advance(49 * 60 * 1000)
    await settled()
    expect(compactions()).toEqual([])

    advance(2 * 60 * 1000)
    await settled()
    expect(compactions()[0]?.record.trigger).toBe('idle')
  })

  it('does not exist under five-minute retention', async () => {
    build('5m')
    await grown()

    advance(4 * 60 * 60 * 1000)
    await settled()
    expect(compactions()).toEqual([])
  })

  // An idle compaction is a paid background request that rewrites what the
  // agent reads, so the switch governs it like everything else. Only the
  // model's own window edge survives the switch being off, which is what the
  // Settings pane says in as many words.
  it('is left alone with the switch off, however long the conversation sits', async () => {
    await grown()
    await shell.setCompactionSettings({ enabled: false, thresholdK: 200 })

    advance(51 * 60 * 1000)
    await settled()

    expect(compactions()).toEqual([])
  })

  it('never marks the session needs-you: it starts no turn and ends none', async () => {
    await grown()
    const before = events.length

    advance(51 * 60 * 1000)
    await settled()

    const since = events.slice(before).map((event) => event.type)
    expect(since).not.toContain('turn_started')
    expect(since).not.toContain('turn_ended')
    expect(since).toContain('compacted')
  })

  // The compaction already priced what the next send writes, so the miss it
  // may pay is evidence rather than an alarm: the strip counts the misses
  // nobody saw coming.
  it('has the next send’s miss recorded as one that was accounted for', async () => {
    const sessionId = await grown()
    advance(51 * 60 * 1000)
    await settled()
    expect(compactions()[0]?.record.trigger).toBe('idle')

    await turn(sessionId, MISSING)

    expect(written).toHaveLength(1)
    expect(written[0]?.acknowledged).toBe(true)
  })

  it('leaves a later send’s miss counted as usual', async () => {
    const sessionId = await grown()
    advance(51 * 60 * 1000)
    await settled()
    await turn(sessionId, MISSING)
    await turn(sessionId, MISSING)

    expect(written).toHaveLength(2)
    expect(written[1]?.acknowledged).toBeUndefined()
  })
})

// Two independent facts, and only one of them is always there. The threshold
// and the window edge are rules about size; a provider that caches nothing —
// a local server, or anything whose usage carries neither a cache read nor a
// cache write — reports no prefix, and a conversation gated on one would grow
// until the model refused it and then error on every send.
describe('a conversation whose provider reports no prompt cache', () => {
  /** The same adapter, saying what a provider that never caches says. */
  const uncached = (adapter: ConversationAdapter): ConversationAdapter => ({
    ...adapter,
    onEvent: (listener: AdapterEventListener) =>
      adapter.onEvent((event) => {
        if (event.type !== 'usage') return listener(event)
        const stripped = { ...event }
        delete (stripped as { cachedPrefix?: unknown }).cachedPrefix
        return listener(stripped)
      })
  })

  it('still compacts when it crosses the threshold', async () => {
    build('1h', uncached)
    const sessionId = await grown()
    await shell.setCompactionSettings({ enabled: true, thresholdK: MIN_THRESHOLD_K })
    await turn(sessionId, 'and the next thing')

    expect(compactions()[0]?.record.trigger).toBe('threshold')
  })

  it('still compacts at the model’s window with the switch off', async () => {
    build('1h', uncached)
    const sessionId = await grown()
    await shell.setCompactionSettings({ enabled: false, thresholdK: 200 })
    await turn(sessionId, 'y'.repeat(600_000))

    expect(compactions()[0]?.record.trigger).toBe('windowEdge')
  })

  // The idle rule is the one rule about the cache, and there is no cache here
  // to run ahead of: compacting on the clock would buy nothing and cost a
  // model call.
  it('has no idle clock to run', async () => {
    build('1h', uncached)
    await grown()

    advance(4 * 60 * 60 * 1000)
    await settled()
    expect(compactions()).toEqual([])
  })
})

describe('a compaction and a live turn', () => {
  // A compaction takes the conversation away from whoever is using it, so a
  // trigger that comes due mid-turn waits for the turn rather than killing it.
  it('waits for the turn a trigger came due inside', async () => {
    const sessionId = await grown()
    await shell.setCompactionSettings({ enabled: true, thresholdK: MIN_THRESHOLD_K })

    const started = shell.prompt(sessionId, 'and the next thing')
    expect(compactions()).toEqual([])
    await started
    await settled()

    expect(compactions()).toHaveLength(1)
  })
})

describe('a message that arrives during a compaction', () => {
  // A run's report and a monitor's wake take the same road a person's send
  // does, so none of them lands on a window being rewritten.
  it('waits for it, whoever sent it', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    build('1h', (adapter) => ({
      ...adapter,
      compact: async (sessionId, trigger) => {
        await held
        return adapter.compact(sessionId, trigger)
      }
    }))
    const sessionId = await grown()

    advance(51 * 60 * 1000)
    await settled()
    expect((await shell.snapshot()).sessions[0]?.compacting).toBe(true)

    void shell.deliver(sessionId, { text: 'a run reporting in' })
    await settled()
    expect(await said(sessionId)).not.toContain('a run reporting in')

    release()
    await settled()
    expect(await said(sessionId)).toContain('a run reporting in')
  })
})
