// @vitest-environment node
//
// The fake adapter is tested through the agent port, which is the only thing a
// caller — the chat pane, main's handler, another test — ever sees of it.
//
// What a caller may expect of the canned reply is stated here, not imported
// from the module under test: a test that read the script out of the
// implementation would move with it and could never fail when it changed.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeAdapter } from './fake-adapter'
import type { PortEvent } from './port'

/**
 * The reply the fake is scripted with today, written out independently of the
 * module that produces it. It arrives in more than one piece — that it streams
 * at all is the point of the fake — but where the pieces are cut is the
 * adapter's business and nothing here asserts it.
 */
const CANNED_REPLY =
  'Hello from the fake adapter.' +
  ' Nothing was sent anywhere and nothing was paid for this reply.'

/** Collects everything a port says, in the order it says it. */
function record(port: ReturnType<typeof createFakeAdapter>): {
  events: PortEvent[]
  stop: () => void
} {
  const events: PortEvent[] = []
  const stop = port.onEvent((event) => events.push(event))
  return { events, stop }
}

function isTerminal(event: PortEvent | undefined, turnId: string): boolean {
  return (
    event !== undefined &&
    event.turnId === turnId &&
    (event.type === 'turn_ended' || event.type === 'error')
  )
}

/**
 * Lets a zero-pause turn run to completion on microtasks alone: the turn is
 * over when its terminal event has arrived, and the loop is bounded so a fake
 * that never terminated fails here rather than hanging.
 */
async function untilTurnEnds(events: readonly PortEvent[], turnId: string): Promise<void> {
  for (let step = 0; step < 1000; step += 1) {
    if (events.some((event) => isTerminal(event, turnId))) return
    await Promise.resolve()
  }
  throw new Error(`the turn ${turnId} never ended`)
}

function deltasOf(events: readonly PortEvent[], turnId: string): string {
  return events
    .filter((event) => event.type === 'text_delta' && event.turnId === turnId)
    .map((event) => (event.type === 'text_delta' ? event.delta : ''))
    .join('')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the fake adapter', () => {
  it('answers a prompt with the scripted turn, in order', async () => {
    const port = createFakeAdapter({ deltaPauseMs: 0 })
    const { events } = record(port)

    const turnId = await port.prompt('Hello agent')
    await untilTurnEnds(events, turnId)

    const types = events.map((event) => event.type)
    expect(types[0]).toBe('turn_started')
    expect(types.at(-1)).toBe('turn_ended')
    // Streaming is the point: the reply arrives in pieces, not in one delta.
    expect(types.slice(1, -1).length).toBeGreaterThan(1)
    expect(types.slice(1, -1).every((type) => type === 'text_delta')).toBe(true)
    expect(events.every((event) => event.turnId === turnId)).toBe(true)
    expect(deltasOf(events, turnId)).toBe(CANNED_REPLY)
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
    await untilTurnEnds(events, first)
    await untilTurnEnds(events, second)

    expect([first, second]).toEqual(['t-1', 't-2'])
    for (const turnId of [first, second]) {
      const turn = events.filter((event) => event.turnId === turnId)
      expect(turn[0]?.type).toBe('turn_started')
      expect(turn.at(-1)?.type).toBe('turn_ended')
      // The same script whatever was asked, so the text does not depend on it.
      expect(deltasOf(events, turnId)).toBe(CANNED_REPLY)
    }
  })

  it('gives every listener every event, and stops at unsubscribe', async () => {
    const port = createFakeAdapter({ deltaPauseMs: 0 })
    const first = record(port)
    const second = record(port)

    const one = await port.prompt('Hello agent')
    await untilTurnEnds(first.events, one)
    expect(second.events).toEqual(first.events)

    const seen = first.events.length
    second.stop()
    second.stop() // unsubscribe is idempotent
    const two = await port.prompt('again')
    await untilTurnEnds(first.events, two)

    expect(second.events).toHaveLength(seen)
    expect(first.events.length).toBeGreaterThan(seen)
  })

  it('replays nothing to a listener that arrives mid-turn', async () => {
    const port = createFakeAdapter({ deltaPauseMs: 0 })
    const early = record(port)

    const turnId = await port.prompt('Hello agent')
    await Promise.resolve()
    await Promise.resolve()
    const late = record(port)
    expect(early.events.length).toBeGreaterThan(0)
    expect(late.events).toEqual([])

    await untilTurnEnds(early.events, turnId)

    // Subscription is live-only: the latecomer holds a suffix of the turn, and
    // never the events that had already gone out.
    expect(late.events.length).toBeLessThan(early.events.length)
    expect(early.events.slice(early.events.length - late.events.length)).toEqual(late.events)
    expect(late.events.at(-1)).toEqual({ type: 'turn_ended', turnId })
  })

  it('delivers an in-flight event to a listener another listener just dropped', async () => {
    const port = createFakeAdapter({ deltaPauseMs: 0 })
    const seenBySecond: PortEvent[] = []

    let dropSecond = (): void => {}
    const stopFirst = port.onEvent(() => {
      dropSecond()
    })
    dropSecond = port.onEvent((event) => {
      seenBySecond.push(event)
    })

    const turnId = await port.prompt('Hello agent')
    const later = record(port)
    await untilTurnEnds(later.events, turnId)

    // The listeners are snapshotted per event, so the second one still received
    // the event that was being delivered when the first dropped it — and
    // nothing after that.
    expect(seenBySecond).toEqual([{ type: 'turn_started', turnId }])
    stopFirst()
  })

  it('paces the deltas at the cadence it is given', async () => {
    vi.useFakeTimers()
    const port = createFakeAdapter({ deltaPauseMs: 5 })
    const { events } = record(port)

    await port.prompt('Hello agent')

    // A pause is a timer, so nothing but the start has arrived yet.
    expect(events).toEqual([{ type: 'turn_started', turnId: 't-1' }])
    await vi.advanceTimersByTimeAsync(4)
    expect(events).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(events).toHaveLength(2)
    expect(events.at(-1)?.type).toBe('text_delta')
  })

  it('paces the deltas by default too, one event per beat, the end on its own beat', async () => {
    vi.useFakeTimers()
    // No cadence given: the default is a positive pause, whatever its length —
    // driving the next timer never names it.
    const port = createFakeAdapter()
    const { events } = record(port)

    const turnId = await port.prompt('Hello agent')
    expect(events).toEqual([{ type: 'turn_started', turnId }])

    let beats = 0
    while (!events.some((event) => isTerminal(event, turnId))) {
      const before = events.length
      beats += 1
      expect(beats).toBeLessThan(1000)
      await vi.advanceTimersToNextTimerAsync()
      // One beat of the script, one event.
      expect(events.length).toBe(before + 1)
    }

    // The terminal event had a beat of its own, after the last delta.
    expect(events.at(-1)).toEqual({ type: 'turn_ended', turnId })
    expect(events.at(-2)?.type).toBe('text_delta')
    expect(beats).toBeGreaterThan(2)
    expect(deltasOf(events, turnId)).toBe(CANNED_REPLY)
  })

  it('emits events that survive structured clone', async () => {
    const port = createFakeAdapter({ deltaPauseMs: 0 })
    const { events } = record(port)

    const turnId = await port.prompt('Hello agent')
    await untilTurnEnds(events, turnId)

    for (const event of events) {
      const cloned = structuredClone(event)
      expect(cloned).not.toBe(event)
      expect(cloned).toEqual(event)
      expect(Object.getPrototypeOf(cloned)).toBe(Object.prototype)
    }
    // All three variants the fake produces were exercised, not just one.
    expect(new Set(events.map((event) => event.type))).toEqual(
      new Set(['turn_started', 'text_delta', 'turn_ended'])
    )
  })
})
