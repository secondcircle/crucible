import type {
  AgentPort,
  PortEvent,
  PortEventListener,
  TurnId,
  Unsubscribe
} from '../../../shared/agent/port'

/**
 * The renderer's half of the agent channel: an agent port over the preload
 * surface (D4, D7).
 *
 * This is the one module in the renderer that may name `window.crucible` — the
 * import fence says so — and it exists so that nothing else has to. What it
 * hands back is the port and only the port, so the pane it feeds cannot tell
 * that a process boundary was crossed at all.
 *
 * Two facts a caller may rely on beyond the port's own contract:
 *
 * - It drops any event whose turn it does not know, and a turn is this
 *   document's own or it is nothing: known by the id its own `prompt` came back
 *   with, until that turn's terminal event. Main outlives the document — the
 *   same handler, still counting turns, serves whatever loads next — so events
 *   from before a reload can still arrive, and a fresh transcript is never
 *   appended to by a turn nobody here asked for. A second terminal event for a
 *   turn already closed is stale in the same way. The port's contract allows a
 *   turn's events to arrive before the `prompt` that asked for it resolves, and
 *   those are heard in full: they are held until the id comes back and can say
 *   whose they are, never guessed at from their arrival order.
 * - It subscribes to the preload surface once, when it is built, and fans out
 *   to its own listeners. Subscribing and unsubscribing a pane therefore costs
 *   nothing and loses nothing — the client is the document's, not a component's.
 */

/** The preload surface, as the renderer sees it: one object, one member (D7). */
interface CrucibleAgent {
  prompt(text: string): Promise<TurnId>
  onEvent(listener: (event: PortEvent) => void): () => void
}

declare global {
  interface Window {
    crucible?: { agent: CrucibleAgent }
  }
}

export function createIpcClient(): AgentPort {
  const agent = window.crucible?.agent
  if (agent === undefined) {
    throw new Error('renderer: window.crucible is missing — the preload did not load')
  }

  const listeners = new Set<PortEventListener>()
  /**
   * Every turn this document asked for, and how far along that turn is. Only a
   * prompt coming back with an id writes to this map — an incoming event can
   * move a turn along but can never make one this document's.
   */
  const mine = new Map<TurnId, 'awaiting-start' | 'open' | 'closed'>()
  /** Prompts in flight whose turn id has not come back yet. */
  let outstanding = 0
  /**
   * Events for an id that is not known to be this document's — yet, or ever.
   * While a prompt is in flight its id is not here to compare against, so such
   * an event is either that prompt's or another document's and there is no way
   * to tell which until the id arrives. Holding is what makes waiting possible:
   * it is at most the events main streamed from inside the handler it has not
   * answered yet, and every one of them is decided by `settle`.
   */
  let held: PortEvent[] = []

  function deliver(event: PortEvent): void {
    // A copy, so a listener that unsubscribes while being called does not
    // disturb the delivery of that same event to the others.
    for (const listener of [...listeners]) listener(event)
  }

  /**
   * Move a turn of this document's along, and say whether this event is one the
   * pane should hear. A turn starts once, speaks while open and says nothing
   * after its terminal event.
   */
  function advance(event: PortEvent, state: 'awaiting-start' | 'open' | 'closed'): boolean {
    if (event.type === 'turn_started') {
      if (state !== 'awaiting-start') return false
      mine.set(event.turnId, 'open')
      return true
    }
    if (state !== 'open') return false
    if (event.type !== 'text_delta') mine.set(event.turnId, 'closed')
    return true
  }

  /**
   * The one gate every event passes, whether it arrives from the surface or
   * comes back off the held queue: an id this document owns is delivered, an id
   * it does not own waits while there is still a prompt that could claim it,
   * and otherwise it is dropped.
   */
  function receive(event: PortEvent): void {
    const state = mine.get(event.turnId)
    if (state !== undefined) {
      if (advance(event, state)) deliver(event)
      return
    }
    if (outstanding > 0) held.push(event)
  }

  /**
   * A prompt has been answered — with the turn's id, or with nothing at all if
   * it failed. The id makes that turn this document's, and everything held is
   * then put back through the gate: what belongs to a now-known turn is heard
   * in the order it arrived, what is still unattributable waits for another
   * prompt in flight, and what nothing is owed to is dropped.
   */
  function settle(id: TurnId | undefined): void {
    outstanding -= 1
    if (id !== undefined) mine.set(id, 'awaiting-start')
    const waiting = held
    held = []
    for (const event of waiting) receive(event)
  }

  agent.onEvent(receive)

  return {
    async prompt(text: string): Promise<TurnId> {
      outstanding += 1
      let id: TurnId
      try {
        id = await agent.prompt(text)
      } catch (cause) {
        // Nothing was accepted, so this prompt is owed no turn: whatever was
        // held on its account belongs to somebody else.
        settle(undefined)
        throw cause
      }
      settle(id)
      return id
    },

    onEvent(listener: PortEventListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
