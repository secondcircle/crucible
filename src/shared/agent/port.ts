/**
 * The agent port: the Crucible-owned interface between the UI layer and
 * everything agent-side (D1).
 *
 * This module imports nothing, on purpose. It is the one module the renderer
 * shares with the main process, so an import added here is the single edit that
 * could smuggle a π SDK type across the seam — the line to watch in review.
 *
 * Two operations are the whole of it: send a prompt, answered with a turn id
 * once the turn is accepted; subscribe, answered with an unsubscribe. A caller
 * need not know which adapter answered, whether a process boundary was crossed,
 * or that the call was logged.
 */

/** Identifies one turn — one prompt and everything streamed back for it. */
export type TurnId = string

/** Why a turn ended in an error, in the only two ways a caller can act on. */
export type PortErrorCode =
  /** A prompt arrived while another turn was live and was refused (D6). */
  | 'busy'
  /** The adapter behind the port failed for this turn. */
  | 'adapter'

/**
 * Everything the port says, and all it says (D3).
 *
 * Every accepted prompt produces exactly one `turn_started`, then zero or more
 * `text_delta`, then exactly one terminal event — `turn_ended` or `error`. An
 * immediate failure is still `turn_started` then `error`: there is no bare-error
 * sequence for an adapter to produce or a test to expect. `turn_ended` carries
 * no text, because a turn's text is its accumulated deltas and nothing
 * reconciles them after the fact.
 *
 * Every event is a plain object so it survives Electron's structured clone, and
 * `error.message` is display-safe text for the pane — stacks, SDK error objects
 * and provider payloads belong in the run log, never in an event.
 */
export type PortEvent =
  | { readonly type: 'turn_started'; readonly turnId: TurnId }
  | { readonly type: 'text_delta'; readonly turnId: TurnId; readonly delta: string }
  | { readonly type: 'turn_ended'; readonly turnId: TurnId }
  | {
      readonly type: 'error'
      readonly turnId: TurnId
      readonly code: PortErrorCode
      readonly message: string
    }

/** What a subscriber is handed each event, in the order the port emits them. */
export type PortEventListener = (event: PortEvent) => void

/** Ends a subscription. Calling it more than once is allowed and does nothing. */
export type Unsubscribe = () => void

/**
 * The seam itself. Three adapters satisfy it — fake, SDK, IPC client — so what
 * a caller may rely on is stated here rather than per adapter:
 *
 * - `prompt` resolves when the turn is *accepted*, not when it is finished, and
 *   whoever answers it mints that turn's id: main's handler for everything
 *   crossing IPC, the adapter itself when a test drives it directly. Ids are
 *   unique per port instance.
 * - Events may arrive before the `prompt` promise resolves, so a caller
 *   subscribes first and prompts second.
 * - Subscription is live-only: no replay, no backlog. Multiple listeners are
 *   allowed and each gets every event.
 * - One turn at a time is not an adapter's rule but main's (D6): an adapter
 *   driven straight from a test serves whatever it is asked.
 */
export interface AgentPort {
  /** Accepted, not finished: resolves with the turn id once the turn starts. */
  prompt(text: string): Promise<TurnId>
  /** Returns an unsubscribe, like the SDK's own subscribe. */
  onEvent(listener: PortEventListener): Unsubscribe
}

/**
 * An adapter with work to stop: the agent port, plus the one operation its
 * owner needs and its callers never see.
 *
 * A caller of the port never learns what stands behind it, but something
 * usually does — the SDK adapter's session, the fake adapter's scheduled
 * script — and that work runs on after the document that asked for it is gone
 * unless someone stops it. So whoever builds an adapter hands it to main's
 * agent channel, which owns it from then on and disposes it when the window
 * that was watching navigates away, closes or quits (D6). The renderer never
 * sees this type: what crosses IPC is the port and nothing else.
 *
 * `dispose` is not the end of the object's life. It abandons whatever is in
 * flight and releases what stood behind it — the abandoned turn says nothing
 * more — while the adapter itself serves the next prompt from scratch, which
 * is what lets the document that comes back after a reload prompt immediately.
 * It is idempotent, and doing it with nothing in flight is allowed and does
 * nothing.
 */
export interface AgentAdapter extends AgentPort {
  /** Abandon the work in flight; the adapter stays usable. */
  dispose(): void
}
