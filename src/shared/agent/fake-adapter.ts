import type { AgentAdapter, PortEvent, PortEventListener, TurnId } from './port'

/**
 * The fake adapter: the canned-response implementation of the agent port, and
 * the default launch flavor (D4, D5).
 *
 * It imports neither Electron nor the π SDK, so this one module serves the main
 * process, node unit tests and jsdom component tests alike. What it hides is the
 * script and its cadence: one factory and one option are the whole of its
 * interface, so a caller — the chat pane, main's handler, a test — sees nothing
 * of it but the agent port, and whoever owns it sees one thing more, `dispose`,
 * which stops the script in flight (D6).
 */

/** The scripted reply, split the way it streams. */
const REPLY_DELTAS: readonly string[] = [
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

/**
 * The pause between deltas when nobody says otherwise — long enough that the
 * reply visibly streams into the running app, short enough that a turn is over
 * in about a second.
 */
const DEFAULT_DELTA_PAUSE_MS = 60

/** A turn in flight, from the outside: the one thing that can be done to it. */
interface RunningTurn {
  /** Stop the script where it stands; nothing more is emitted for this turn. */
  abandon(): void
}

/**
 * A fake agent port. Every prompt is accepted — single-flight is main's rule,
 * not an adapter's (D6) — and answered with the same canned reply, whatever it
 * was asked: `turn_started`, the reply as more than one `text_delta`, then
 * `turn_ended`. Turn ids are minted here, `t-1`, `t-2`, …, unique per instance.
 *
 * How the reply reads and where its pieces are cut is this module's own
 * business; the one thing a caller may set is the pause between events.
 *
 * `turn_started` is emitted before `prompt` resolves, which is the contract's
 * ordering rather than an accident of this adapter: a caller subscribes first
 * and prompts second. Every event after it is one pause apart, so a test that
 * drives the clock sees the turn exactly one event at a time.
 *
 * `dispose` stops the scripts in flight — the beats still to come are what this
 * adapter has "running" — and leaves the adapter ready for the next prompt.
 */
export function createFakeAdapter({
  deltaPauseMs = DEFAULT_DELTA_PAUSE_MS
}: {
  /**
   * Milliseconds between deltas. Zero means no timer at all — the turn runs on
   * microtasks — which is what tests pass, so no test ever waits on a clock.
   */
  readonly deltaPauseMs?: number
} = {}): AgentAdapter {
  const listeners = new Set<PortEventListener>()
  const inFlight = new Set<RunningTurn>()
  let turns = 0

  function emit(event: PortEvent): void {
    // A copy, so a listener that unsubscribes while being called does not
    // disturb the delivery of that same event to the others.
    for (const listener of [...listeners]) listener(event)
  }

  /**
   * Runs one turn's script and registers it as in flight until it is over.
   *
   * One pause before each event, the terminal one included: a turn's end is a
   * beat of the script like any other, never something that lands in the same
   * tick as its last delta. A beat that is abandoned is the end of the script:
   * the pending timer is cleared, the wait is released, and the turn falls
   * silent where it stood.
   */
  function run(turnId: TurnId): void {
    let abandoned = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let release: (() => void) | undefined

    // Zero pause resolves on a microtask rather than scheduling: no test waits
    // on a timer.
    function beat(): Promise<void> {
      return new Promise<void>((resolve) => {
        release = resolve
        if (deltaPauseMs <= 0) queueMicrotask(resolve)
        else timer = setTimeout(resolve, deltaPauseMs)
      })
    }

    const turn: RunningTurn = {
      abandon(): void {
        abandoned = true
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        release?.()
      }
    }

    async function script(): Promise<void> {
      for (const delta of REPLY_DELTAS) {
        await beat()
        if (abandoned) return
        emit({ type: 'text_delta', turnId, delta })
      }
      await beat()
      if (abandoned) return
      emit({ type: 'turn_ended', turnId })
    }

    inFlight.add(turn)
    void script().finally(() => inFlight.delete(turn))
  }

  return {
    // The script is the same whatever is asked, so the prompt text is not a
    // parameter here — a method that takes fewer arguments than the port's
    // `prompt(text)` still satisfies it.
    prompt(): Promise<TurnId> {
      turns += 1
      const turnId = `t-${turns}`
      emit({ type: 'turn_started', turnId })
      run(turnId)
      return Promise.resolve(turnId)
    },

    onEvent(listener: PortEventListener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    // Subscriptions are left alone: whoever is listening keeps listening, and
    // hears the next turn in full. Only the scripts in flight are dropped.
    dispose(): void {
      for (const turn of [...inFlight]) turn.abandon()
      inFlight.clear()
    }
  }
}
