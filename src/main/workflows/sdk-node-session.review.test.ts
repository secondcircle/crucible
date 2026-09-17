// @vitest-environment node
//
// Review 2, finding 3. Delete this file with the fix.
//
// The idle rule "fires only when there is a warm cache and something to
// compact", and the shell honors that: it reports `lastRequestAt` only when
// the provider said it is holding a prefix, and a conversation on a provider
// that caches nothing has "no idle clock to run"
// (shell.compaction.test.ts). `noteSize` in the node wrapper reports the last
// assistant message's timestamp unconditionally, so a node on a provider that
// never caches still compacts at minute fifty: a paid, cold, whole-context
// request that saves nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { StoredMessage } from '../agent/sdk-transcript'
import { wrapNodeSession } from './sdk-node-session'

type Listener = (event: unknown) => void

/** A session on a provider that reports no cache activity at all. */
function uncached(): {
  readonly session: AgentSession
  say(usedTokens: number): void
  readonly compactions: () => number
} {
  const listeners = new Set<Listener>()
  let usage = { tokens: 1_000, contextWindow: 1_000_000 }
  let compactions = 0

  const session = {
    get isStreaming() {
      return false
    },
    thinkingLevel: 'medium',
    messages: [],
    sessionManager: { getEntries: () => [], getBranch: () => [] },
    subscribe(listener: Listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getContextUsage: () => usage,
    getSessionStats: () => ({ cost: 0 }),
    async prompt() {},
    async compact() {
      compactions += 1
    },
    abortCompaction() {},
    async abort() {},
    dispose() {}
  } as unknown as AgentSession

  return {
    session,
    say(usedTokens: number) {
      usage = { tokens: usedTokens, contextWindow: 1_000_000 }
      // No `usage` on the message: nothing was cached, so there is no prefix
      // for a later request to lose.
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        timestamp: Date.now()
      } as unknown as StoredMessage
      for (const listener of listeners) listener({ type: 'message_end', message })
    },
    compactions: () => compactions
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a node on a provider that reports no prompt cache', () => {
  it('has no idle clock to run', async () => {
    const fake = uncached()
    const node = wrapNodeSession(
      fake.session,
      { skills: [], cwd: '/repos/crucible' },
      {},
      {
        // Far above the conversation: only the idle rule could fire here.
        settings: () => ({ enabled: true, thresholdK: 10_000 }),
        begin: () => {},
        entryToMessages: () => [],
        onFailure: () => {}
      }
    )

    fake.say(400_000)
    await vi.advanceTimersByTimeAsync(51 * 60 * 1000)

    expect(fake.compactions()).toBe(0)
    node.dispose()
  })
})
