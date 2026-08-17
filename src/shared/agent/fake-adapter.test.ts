// @vitest-environment node
//
// The fake adapter is tested through the agent port, which is the only thing a
// caller — the chat pane, main's handler, another test — ever sees of it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FAKE_REPLY, FAKE_REPLY_DELTAS, createFakeAdapter } from './fake-adapter'
import type { PortEvent } from './port'

/** Collects everything a port says, in the order it says it. */
function record(port: ReturnType<typeof createFakeAdapter>): {
  events: PortEvent[]
  stop: () => void
} {
  const events: PortEvent[] = []
  const stop = port.onEvent((event) => events.push(event))
  return { events, stop }
}

/** Lets every pending microtask of a zero-pause turn run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 2 * (FAKE_REPLY_DELTAS.length + 2); i += 1) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the fake adapter', () => {
  it('answers a prompt with the scripted turn, in order', async () => {
    const port = createFakeAdapter({ deltaPauseMs: 0 })
    const { events } = record(port)

    const turnId = await port.prompt('Hello agent')
    await settle()

    expect(FAKE_REPLY_DELTAS.length).toBeGreaterThan(1)
    expect(events.map((event) => event.type)).toEqual([
      'turn_started',
      ...FAKE_REPLY_DELTAS.map(() => 'text_delta'),
      'turn_ended'
    ])
    expect(events.every((event) => event.turnId === turnId)).toBe(true)
    expect(
      events
        .filter((event) => event.type === 'text_delta')
        .map((event) => event.delta)
        .join('')
    ).toBe(FAKE_REPLY)
  })

  it('emits turn_started before the prompt promise resolves', async () => {
    const port = createFakeAdapter({ deltaPauseMs: 0 })
    const { events } = record(port)

    const accepted = port.prompt('Hello agent')

    expect(events).toEqual([{ type: 'turn_started', turnId: 't-1' }])
    await accepted
  })

  it('mints one id per turn and serves whatever it is asked (D6 is main’s rule)', async () => {
    const port = createFakeAdapter({ deltaPauseMs: 0 })
    const { events } = record(port)

    const first = await port.prompt('one')
    const second = await port.prompt('two')
    await settle()

    expect([first, second]).toEqual(['t-1', 't-2'])
    for (const turnId of [first, second]) {
      const turn = events.filter((event) => event.turnId === turnId)
      expect(turn[0]?.type).toBe('turn_started')
      expect(turn.at(-1)?.type).toBe('turn_ended')
    }
  })

  it('gives every listener every event, and stops at unsubscribe', async () => {
    const port = createFakeAdapter({ deltaPauseMs: 0 })
    const first = record(port)
    const second = record(port)

    await port.prompt('Hello agent')
    await settle()
    expect(second.events).toEqual(first.events)

    const seen = first.events.length
    second.stop()
    second.stop() // unsubscribe is idempotent
    await port.prompt('again')
    await settle()

    expect(second.events).toHaveLength(seen)
    expect(first.events.length).toBeGreaterThan(seen)
  })

  it('paces the deltas when asked, so the reply streams into the app', async () => {
    vi.useFakeTimers()
    const port = createFakeAdapter({ deltaPauseMs: 5 })
    const { events } = record(port)

    await port.prompt('Hello agent')
    await settle()

    // A pause is a timer, so nothing but the start has arrived yet.
    expect(events).toEqual([{ type: 'turn_started', turnId: 't-1' }])

    await vi.advanceTimersByTimeAsync(5)
    expect(events.at(-1)).toEqual({
      type: 'text_delta',
      turnId: 't-1',
      delta: FAKE_REPLY_DELTAS[0]
    })

    await vi.advanceTimersByTimeAsync(5 * (FAKE_REPLY_DELTAS.length + 1))
    expect(events.at(-1)).toEqual({ type: 'turn_ended', turnId: 't-1' })
  })
})
