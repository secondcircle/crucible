import type { AgentPort, PortEvent, PortEventListener, TurnId } from './port'

/**
 * The fake adapter: the canned-response implementation of the agent port, and
 * the default launch flavor (D4, D5).
 *
 * It imports neither Electron nor the π SDK, so this one module serves the main
 * process, node unit tests and jsdom component tests alike. What it hides is the
 * script and its cadence — the one place a test's expected output lives, which
 * is why the reply is exported as constants rather than written out again in
 * every test.
 */

/**
 * The scripted reply, split the way it streams. A test importing this asserts
 * against what the app actually renders; a test that spelled the string out
 * again would only assert against itself.
 */
export const FAKE_REPLY_DELTAS: readonly string[] = [
  'Hello',
  ' from',
  ' the',
  ' fake',
  ' adapter',
  '.',
  ' Nothing',
  ' was',
  ' sent',
  ' anywhere',
  ' and',
  ' nothing',
  ' was',
  ' paid',
  ' for',
  ' this',
  ' reply',
  '.'
]

/** The whole scripted reply: what the deltas add up to once a turn has ended. */
export const FAKE_REPLY: string = FAKE_REPLY_DELTAS.join('')

/**
 * The pause between deltas when nobody says otherwise — long enough that the
 * reply visibly streams into the running app, short enough that a turn is over
 * in about a second.
 */
export const FAKE_DELTA_PAUSE_MS = 60

export interface FakeAdapterOptions {
  /**
   * Milliseconds between deltas. Zero means no timer at all — the turn runs on
   * microtasks — which is what tests pass, so no test ever waits on a clock.
   */
  readonly deltaPauseMs?: number
}

/** Zero pause resolves now rather than scheduling: no test waits on a timer. */
function pause(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A fake agent port. Every prompt is accepted — single-flight is main's rule,
 * not an adapter's (D6) — and answered with the same script: `turn_started`,
 * one `text_delta` per entry of {@link FAKE_REPLY_DELTAS}, then `turn_ended`.
 * Turn ids are minted here, `t-1`, `t-2`, …, unique per adapter instance.
 *
 * `turn_started` is emitted before `prompt` resolves, which is the contract's
 * ordering rather than an accident of this adapter: a caller subscribes first
 * and prompts second. Every event after it is one pause apart, so a test that
 * drives the clock sees the turn exactly one event at a time.
 */
export function createFakeAdapter({
  deltaPauseMs = FAKE_DELTA_PAUSE_MS
}: FakeAdapterOptions = {}): AgentPort {
  const listeners = new Set<PortEventListener>()
  let turns = 0

  function emit(event: PortEvent): void {
    // A copy, so a listener that unsubscribes while being called does not
    // disturb the delivery of that same event to the others.
    for (const listener of [...listeners]) listener(event)
  }

  // One pause before each event, the terminal one included: a turn's end is a
  // beat of the script like any other, never something that lands in the same
  // tick as its last delta.
  async function stream(turnId: TurnId): Promise<void> {
    for (const delta of FAKE_REPLY_DELTAS) {
      await pause(deltaPauseMs)
      emit({ type: 'text_delta', turnId, delta })
    }
    await pause(deltaPauseMs)
    emit({ type: 'turn_ended', turnId })
  }

  return {
    // The script is the same whatever is asked, so the prompt text is not a
    // parameter here — a method that takes fewer arguments than the port's
    // `prompt(text)` still satisfies it.
    prompt(): Promise<TurnId> {
      turns += 1
      const turnId = `t-${turns}`
      emit({ type: 'turn_started', turnId })
      void stream(turnId)
      return Promise.resolve(turnId)
    },

    onEvent(listener: PortEventListener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
