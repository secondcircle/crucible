import { ipcMain, type BrowserWindow } from 'electron'
import { EVENT_CHANNEL, PROMPT_CHANNEL } from '../../shared/agent/channels'
import type { AgentAdapter, PortEvent, TurnId } from '../../shared/agent/port'

/**
 * Main's half of the agent channel: the ordering authority (D6).
 *
 * `serveAgentChannel` puts an agent port behind the two IPC channels the
 * preload surface speaks, for the lifetime of one window. Everything a caller
 * has to know is here:
 *
 * - It is the single-flight guard. One turn at a time, app-global — there is
 *   only ever one window (D2) — and a prompt arriving while a turn is live is
 *   refused as the new turn's own terminal `error` with code `busy`, while the
 *   live turn runs on untouched and keeps the guard.
 * - It mints the turn ids the renderer sees, `t-1`, `t-2`, …, because whoever
 *   answers a prompt mints its id. The adapter behind it mints ids of its own
 *   for the same turns; those never leave this module.
 * - It never throws across IPC. Electron serializes a handler's throw down to
 *   its `message`, so every failure — a live turn, a payload that is not a
 *   string, an adapter that rejects — is answered with a turn id and reported
 *   as that turn's terminal event instead.
 * - It owns the adapter's lifetime, which is why it takes an adapter and not a
 *   bare port. The adapter answers to the document that is watching, so when
 *   that document goes away — navigation, close, quit — the adapter is disposed
 *   whether or not a turn was live: its work stops rather than running on
 *   unseen, the guard is released, nothing more is sent for the abandoned turn,
 *   and the document that comes back prompts immediately, served from scratch.
 *   Any event still in flight for an abandoned turn is dropped rather than
 *   re-tagged, so it can never stream into a fresh transcript.
 *
 * What it hides: the channel names, turn-id correlation across the process
 * boundary, the structured-clone-safe shape of what is sent, the adapter's
 * lifetime and the guard itself. A caller composes it in one line and disposes
 * it at quit.
 */
export interface AgentChannel {
  /**
   * Stop serving: dispose the adapter — the live turn and whatever stood behind
   * it included — release the guard, unsubscribe from the adapter and
   * unregister the handler. Idempotent, and already wired to the window's own
   * close — a caller needs it only for app quit and for tests.
   */
  dispose(): void
}

/**
 * The turn this channel is serving right now, as far as the renderer is
 * concerned. `adapterTurnId` is unknown until the adapter says its turn has
 * started, which is how events are correlated: the guard means at most one
 * adapter turn can be starting at a time, so the first `turn_started` after a
 * prompt is accepted belongs to that prompt, and every event carrying another
 * id is stale.
 */
interface LiveTurn {
  readonly id: TurnId
  adapterTurnId: TurnId | undefined
  started: boolean
  /** Set when the document that asked for this turn went away (D6). */
  abandoned: boolean
}

/** Display-safe text for a failure that never reaches the renderer otherwise. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function serveAgentChannel(adapter: AgentAdapter, window: BrowserWindow): AgentChannel {
  const { webContents } = window
  let serving = true
  let turns = 0
  let live: LiveTurn | undefined

  function send(event: PortEvent): void {
    if (!serving || webContents.isDestroyed()) return
    webContents.send(EVENT_CHANNEL, event)
  }

  /** Exactly one `turn_started` per turn, and always before anything else. */
  function begin(turn: LiveTurn): void {
    if (turn.started) return
    turn.started = true
    send({ type: 'turn_started', turnId: turn.id })
  }

  /** A turn's one terminal event, which is also what releases the guard. */
  function end(turn: LiveTurn, event: PortEvent): void {
    begin(turn)
    send(event)
    if (live === turn) live = undefined
  }

  /**
   * The one path a document going away takes — reload, close, quit. Everything
   * that ends a document's claim on the adapter is here rather than at each of
   * the three events that can trigger it, so D6's "reload, close or quit
   * disposes that session and frees the guard" is enforced in one place: any
   * live turn is marked so nothing sends for it again, the guard falls, and the
   * adapter drops what it was holding — unconditionally, because a session
   * outlives the turns it served and a document that finished its turn still
   * leaves one behind. The adapter stays usable, which is what lets the next
   * document prompt at once.
   */
  function releaseAdapter(): void {
    if (live !== undefined) {
      live.abandoned = true
      live = undefined
    }
    adapter.dispose()
  }

  /**
   * Everything the adapter says, re-tagged with the id the renderer knows and
   * filtered down to the live turn. An event belonging to no live turn — a turn
   * a reload abandoned, anything after a terminal event — is dropped here.
   */
  const unsubscribe = adapter.onEvent((event) => {
    const turn = live
    if (turn === undefined) return

    if (turn.adapterTurnId === undefined) {
      // Nothing is known of this turn's adapter id until the adapter starts it,
      // so anything arriving before that belongs to an earlier turn.
      if (event.type !== 'turn_started') return
      turn.adapterTurnId = event.turnId
    } else if (event.turnId !== turn.adapterTurnId) {
      return
    }

    switch (event.type) {
      case 'turn_started':
        begin(turn)
        return
      case 'text_delta':
        begin(turn)
        send({ type: 'text_delta', turnId: turn.id, delta: event.delta })
        return
      case 'turn_ended':
        end(turn, { type: 'turn_ended', turnId: turn.id })
        return
      case 'error':
        end(turn, {
          type: 'error',
          turnId: turn.id,
          code: event.code,
          message: event.message
        })
        return
    }
  })

  ipcMain.handle(PROMPT_CHANNEL, async (_invocation, text: unknown): Promise<TurnId> => {
    turns += 1
    const id = `t-${turns}`

    // The guard is read before anything else about the prompt: a refusal is a
    // property of the turn already running, not of what was asked.
    if (live !== undefined) {
      // The refusal is the new turn's own terminal event, so it is a turn like
      // any other here — one that starts and ends without ever being live.
      end(
        { id, adapterTurnId: undefined, started: false, abandoned: false },
        {
          type: 'error',
          turnId: id,
          code: 'busy',
          message: 'Another turn is still running. Wait for it to finish.'
        }
      )
      return id
    }

    const turn: LiveTurn = { id, adapterTurnId: undefined, started: false, abandoned: false }

    if (typeof text !== 'string') {
      // A malformed payload takes no guard: nothing was started, so the next
      // prompt is served rather than refused.
      end(turn, {
        type: 'error',
        turnId: id,
        code: 'adapter',
        message: 'A prompt has to be text.'
      })
      return id
    }

    live = turn
    try {
      const adapterTurnId = await adapter.prompt(text)
      if (turn.abandoned) {
        // The document went away while the adapter was accepting, so what it
        // just started answers to nobody — unless a fresh turn is already live,
        // whose work this must not touch.
        if (live === undefined) adapter.dispose()
        return id
      }
      // Only if the adapter never announced the turn itself — it usually has,
      // synchronously, before `prompt` even resolved.
      if (live === turn && turn.adapterTurnId === undefined) turn.adapterTurnId = adapterTurnId
    } catch (cause) {
      // A port that cannot accept at all still owes the renderer a turn: started
      // first, then the failure, because there is no bare-error sequence (D3).
      if (live === turn) {
        end(turn, { type: 'error', turnId: id, code: 'adapter', message: messageOf(cause) })
      }
    }
    return id
  })

  /**
   * A new document in the window ends whatever the old one was watching: the
   * turn is dropped, the guard falls, and the pane that comes back starts empty
   * and can prompt at once. Same-document navigations change nothing.
   */
  webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    releaseAdapter()
  })

  function dispose(): void {
    if (!serving) return
    serving = false
    releaseAdapter()
    unsubscribe()
    ipcMain.removeHandler(PROMPT_CHANNEL)
  }

  window.on('closed', dispose)

  return { dispose }
}
