// @vitest-environment node
//
// A node is an agent loop like any other, so the same compaction governs it —
// and the same rule that a send during a compaction waits for it. π refuses a
// prompt outright while a compaction is in progress, and the engine's one
// door onto a node swallows what a turn throws: a message that arrives mid
// compaction would otherwise be dropped in silence, the wake's text with it,
// and the node would nudge twice and park as stalled.
//
// Driven against a scripted session that behaves the way π's does. Nothing
// here constructs an SDK session.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { StoredMessage } from '../agent/sdk-transcript'
import { COMPACTION_DETAILS_KEY } from '../agent/sdk-compaction'
import { wrapNodeSession } from './sdk-node-session'

type Listener = (event: unknown) => void

interface Scripted {
  readonly session: AgentSession
  /** What was said and done, in order, so a race shows as an order. */
  readonly log: string[]
  /** Reports an assistant message of this size, as a turn's last act does. */
  say(usedTokens: number): void
  /** Lets the compaction π is running finish, on the window it wrote. */
  finishCompaction(tokensAfter?: number): void
  readonly compactions: () => number
  readonly aborted: () => string[]
  /** What π's own size check was last armed with. */
  readonly armed: () => unknown
  /** π announcing a compaction of its own, between two tool rounds. */
  emit(event: unknown): void
}

function scripted(): Scripted {
  const log: string[] = []
  const aborted: string[] = []
  const listeners = new Set<Listener>()
  let usage = { tokens: 1_000, contextWindow: 1_000_000 }
  let compacting: { resolve: () => void; reject: (cause: unknown) => void } | undefined
  let compactions = 0
  // π's own entries, which is where a compaction's result is written down and
  // where every reader of it — this launch or the next — goes for it.
  const entries: unknown[] = []

  let armed: unknown
  const session = {
    get isStreaming() {
      return false
    },
    thinkingLevel: 'medium',
    model: { contextWindow: 1_000_000 },
    settingsManager: {
      applyOverrides(overrides: { compaction?: unknown }) {
        armed = overrides.compaction
      }
    },
    messages: [],
    sessionManager: { getEntries: () => entries, getBranch: () => entries },
    subscribe(listener: Listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getContextUsage: () => usage,
    getSessionStats: () => ({ cost: 0 }),
    async prompt(text: string) {
      // π's own refusal, verbatim in effect: a prompt during a compaction is
      // not accepted at all.
      if (compacting !== undefined) {
        log.push(`refused:${text}`)
        throw new Error('Cannot submit a prompt while compaction is in progress.')
      }
      log.push(`prompt:${text}`)
    },
    async compact() {
      compactions += 1
      log.push('compact')
      await new Promise<void>((resolve, reject) => {
        compacting = { resolve, reject }
      })
      log.push('compacted')
      compacting = undefined
    },
    abortCompaction() {
      aborted.push('compaction')
      compacting?.reject(new Error('aborted'))
      compacting = undefined
    },
    async abort() {
      aborted.push('turn')
    },
    dispose() {}
  } as unknown as AgentSession

  return {
    session,
    log,
    say(usedTokens: number) {
      usage = { tokens: usedTokens, contextWindow: 1_000_000 }
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        timestamp: Date.now()
      } as unknown as StoredMessage
      for (const listener of listeners) listener({ type: 'message_end', message })
      for (const listener of listeners) listener({ type: 'agent_end' })
    },
    finishCompaction(tokensAfter?: number) {
      // A compaction that wrote something leaves π an entry of its own,
      // carrying Crucible's record in the `details` slot π documents. One that
      // wrote nothing leaves no entry, and the conversation is what it was.
      if (tokensAfter !== undefined) {
        entries.push({
          type: 'compaction',
          details: {
            [COMPACTION_DETAILS_KEY]: {
              record: { trigger: 'threshold', tokensBefore: 0, tokensAfter }
            }
          }
        })
      }
      compacting?.resolve()
      compacting = undefined
    },
    compactions: () => compactions,
    aborted: () => aborted,
    armed: () => armed,
    emit(event: unknown) {
      for (const listener of listeners) listener(event)
    }
  }
}

function node(
  fake: Scripted,
  onFailure: (cause: unknown) => void = () => {},
  thresholdK = 200,
  begin: (trigger: string) => void = () => {}
): ReturnType<typeof wrapNodeSession> {
  return wrapNodeSession(
    fake.session,
    { skills: [], cwd: '/repos/crucible' },
    {},
    {
      settings: () => ({ enabled: true, thresholdK }),
      begin,
      entryToMessages: () => [],
      onFailure
    }
  )
}

/** Long enough for every queued microtask to have run. */
async function settled(): Promise<void> {
  for (let at = 0; at < 3; at += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('a message that arrives while the node is compacting', () => {
  it('waits for the compaction and is then delivered', async () => {
    const fake = scripted()
    const session = node(fake)

    // The node is parked on a monitor: nothing is prompting, so the size the
    // last turn reported fires at once.
    fake.say(400_000)
    expect(fake.compactions()).toBe(1)

    // The monitor wakes, and the engine speaks.
    const woken = session.prompt('a monitor wake arriving mid-compaction')
    await settled()
    expect(fake.log).toEqual(['compact'])

    fake.finishCompaction()
    await woken

    expect(fake.log).toEqual(['compact', 'compacted', 'prompt:a monitor wake arriving mid-compaction'])
    session.dispose()
  })

  // The wake's own text is the whole of what the engine had to say. Refused
  // and swallowed, it resolves in the same tick having said nothing, which
  // the engine reads as a turn that ended without completing.
  it('is never refused and thrown away', async () => {
    const fake = scripted()
    const session = node(fake)

    fake.say(400_000)
    const woken = session.prompt('the wake')
    await settled()
    fake.finishCompaction()
    await woken

    expect(fake.log).not.toContain('refused:the wake')
    session.dispose()
  })
})

describe('a compaction the turn’s own size called for', () => {
  // π's compaction aborts whatever is running first, so one that starts inside
  // the `agent_end` handler races the message the engine sends next: either
  // that message is refused, or the turn it started is aborted.
  it('starts after the turn, and the next message waits for it', async () => {
    const fake = scripted()
    const session = node(fake)

    const first = session.prompt('do the thing')
    fake.say(400_000)
    await first
    expect(fake.compactions()).toBe(1)

    const second = session.prompt('and the next thing')
    await settled()
    fake.finishCompaction()
    await second

    expect(fake.log).toEqual([
      'prompt:do the thing',
      'compact',
      'compacted',
      'prompt:and the next thing'
    ])
    session.dispose()
  })

  // The same two facts a session's rules decide on, through the same watch:
  // what the conversation holds now, and what its own last compaction left it
  // at. A node that never reported the second would compact once and never
  // again — or, worse, once a turn.
  it('waits for growth a compaction could take away before compacting again', async () => {
    const fake = scripted()
    const session = node(fake)

    fake.say(400_000)
    // The words alone were most of it, so the compaction landed over the
    // threshold that asked for it.
    fake.finishCompaction(210_000)
    await settled()
    expect(fake.compactions()).toBe(1)

    // Over the threshold, and a turn's growth over what that compaction
    // produced: another one would buy back a turn.
    fake.say(230_000)
    await settled()
    expect(fake.compactions()).toBe(1)

    fake.say(430_000)
    await settled()
    expect(fake.compactions()).toBe(2)
    session.dispose()
  })
})

// A node is one long turn: the watch above fires between turns, and a node
// has no "between". π checks the size itself between one tool round and the
// next, and the node arms that check at the size the same rules give it, so
// a node that reads files for an hour compacts in the middle of doing so and
// carries on, rather than growing to the window and erroring there.
describe('a compaction inside the turn, between tool rounds', () => {
  it('arms π’s own check at the size the rules fire at, from the first moment', () => {
    const fake = scripted()
    const session = node(fake)
    expect(fake.armed()).toEqual({ enabled: true, reserveTokens: 800_001, keepRecentTokens: 0 })
    session.dispose()
  })

  // What the last compaction left the conversation at moves the point, so the
  // check is re-armed whenever the size is re-read.
  it('re-arms after a compaction, so the next fires only on growth worth taking away', () => {
    const fake = scripted()
    const session = node(fake)
    fake.say(400_000)
    fake.finishCompaction(150_000)
    fake.say(160_000)
    expect(fake.armed()).toEqual({ enabled: true, reserveTokens: 700_001, keepRecentTokens: 0 })
    session.dispose()
  })

  it('records the trigger of a compaction π started, as it would its own', () => {
    const fake = scripted()
    const triggers: string[] = []
    const session = node(fake, () => {}, 200, (trigger) => triggers.push(trigger))
    fake.emit({ type: 'compaction_start', reason: 'threshold' })
    fake.emit({ type: 'compaction_start', reason: 'overflow' })
    // The manual one is the watch's own, which names its trigger itself.
    fake.emit({ type: 'compaction_start', reason: 'manual' })
    expect(triggers).toEqual(['threshold', 'windowEdge'])
    session.dispose()
  })
})

// The idle rule is a rule about the cache: it spends a compaction at minute
// fifty so a warm prefix is read instead of re-billed. On a provider that
// caches nothing there is no prefix to run ahead of, and a compaction there is
// a cold whole-context request that saves nothing — which is why a node reports
// the prefix's own instant, never the message's wall-clock stamp, exactly as a
// session does across the port.
describe('a node on a provider that reports no prompt cache', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('has no idle clock to run', async () => {
    vi.useFakeTimers()
    const fake = scripted()
    // Far above the conversation: only the idle rule could fire here.
    const session = node(fake, () => {}, 10_000)

    fake.say(400_000)
    await vi.advanceTimersByTimeAsync(51 * 60 * 1000)

    expect(fake.compactions()).toBe(0)
    session.dispose()
  })
})

describe('a node released mid-compaction', () => {
  it('abandons the compaction rather than holding the next message behind it', async () => {
    const failures: unknown[] = []
    const fake = scripted()
    const session = node(fake, (cause) => failures.push(cause))

    fake.say(400_000)
    const woken = session.prompt('the wake')
    await settled()
    await session.abort()
    await woken

    expect(fake.aborted()).toEqual(['compaction', 'turn'])
    expect(failures).toHaveLength(1)
    session.dispose()
  })
})
