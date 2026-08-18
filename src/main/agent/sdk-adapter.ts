import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type {
  AgentAdapter,
  PortEvent,
  PortEventListener,
  TurnId,
  Unsubscribe
} from '../../shared/agent/port'
// Spelled with their extensions so this module can also be loaded by plain
// Node — that is what `npm run prove:sdk` does, and Node's ESM resolver has no
// extension guessing. Every other import here is type-only and erased.
import { adapterError } from './adapter-error.ts'
import { toPortEvent } from './to-port-event.ts'

/**
 * The agent port backed by the real π SDK — main only, and the only module in
 * Crucible that opens a paid session (D11).
 *
 * `createSdkAdapter()` is the whole interface: no options, because there is
 * nothing about the session for a caller to choose. What it inherits from the
 * machine is credentials and nothing else — the session and settings are
 * in-memory, so `~/.pi/agent/settings.json` (and the
 * `packages: ["../../repos/pi-extensions"]` in it) is never read, while the
 * model runtime still resolves `~/.pi/agent/auth.json` through the SDK's own
 * default. Provider and model are named here rather than inferred, and tools
 * are off.
 *
 * Behind the port it keeps at most one SDK session, opened as the adapter is
 * built so that bad credentials or an unknown model fail before the first
 * prompt rather than during it. A session that cannot be opened at all turns
 * the *first* prompt into that turn's terminal `error` with code `adapter` —
 * there is no other way for an adapter to report it, since no adapter invents
 * an id for a turn it was not asked for, and no adapter knows logging exists
 * (D8): the run log gets the failure from `withLogging`, as the turn's error.
 *
 * The events it emits are exactly D3's four, in D3's order: one `turn_started`,
 * then zero or more `text_delta`, then exactly one terminal event. The SDK's
 * own union is reduced by `toPortEvent`; the sequencing is kept here, because
 * the port's turn and the SDK's turn are not the same turn. One `prompt()` call
 * can span several SDK turns — a transient provider failure is retried by the
 * SDK itself, which continues the same prompt after emitting the failed
 * message, and compaction continues it the same way — so nothing the stream
 * says about ending is the port's ending. The port turn is bounded by the
 * `prompt()` call: the stream contributes the deltas and its latest word on how
 * the turn is going, and the single terminal event is emitted when `prompt()`
 * returns or throws. That is what keeps retries the SDK's own business (D3) —
 * neither the retry nor the failure it recovered from crosses the port, and the
 * pane keeps its guard while a paid request can still be running.
 * A turn that fails after some deltas keeps them: the deltas stood, and the
 * error is what the pane appends under the partial text. Whichever direction a
 * failure comes from, the text it puts on the port is `adapterError`'s to
 * decide, so a provider payload or a stack has no route across the seam.
 *
 * `dispose()` is what stops a paid request. It abandons the turn in flight,
 * aborts the SDK run and disposes the session — `AgentSession.dispose` only
 * detaches listeners, so aborting first is what keeps a stream from running on
 * unseen after the window that was watching it is gone (D6). The adapter stays
 * usable: the next prompt opens a fresh session, which is what lets the pane
 * that comes back after a reload prompt immediately.
 */

/**
 * The model this milestone is pinned to — Crucible's own constant, not the
 * SDK's, and the one line to change to move the whole app to another model.
 *
 * It is not `anthropic/claude-fable-5`, which is what the steering document
 * named. A bare `createAgentSession` against Anthropic routes to the
 * extra-usage pool rather than the subscription, which on this machine is
 * exhausted: every Anthropic model answers 400 "You're out of extra usage".
 * Subscription usage is only drawn when the product name `pi` is rewritten to
 * the π symbol in the system prompt — the legacy system's `anthropic-pi-symbol`
 * extension — and that behaviour is deliberately not ported here. Until it is,
 * Crucible names a provider that answers.
 */
export const SDK_MODEL = { provider: 'openai-codex', id: 'gpt-5.4-mini' } as const

/** A turn in flight, and everything the sequencing rules need to know about it. */
interface Turn {
  readonly id: TurnId
  started: boolean
  settled: boolean
  abandoned: boolean
  /**
   * The terminal event this turn would end with if the SDK stopped speaking
   * now — `turn_ended` until the stream says otherwise. It is what the turn
   * ends with when `prompt()` returns, and it is not emitted before then.
   */
  outcome: PortEvent
  unsubscribe: Unsubscribe | undefined
}

/**
 * The one session slot. It holds the session while it is still opening as well
 * as once it is open, so a `dispose` that lands mid-open still closes what the
 * open produces instead of leaking it.
 */
interface SessionSlot {
  readonly session: Promise<AgentSession>
  dropped: boolean
}

/**
 * The in-memory session of D11. The SDK is imported dynamically for two
 * reasons: it is ESM-only, so the CommonJS main bundle cannot `require` it, and
 * a fake-flavor launch then never loads it at all.
 */
async function openSession(): Promise<AgentSession> {
  const [{ createAgentSession, SessionManager, SettingsManager }, { getBuiltinModel }] =
    await Promise.all([
      import('@earendil-works/pi-coding-agent'),
      import('@earendil-works/pi-ai/providers/all')
    ])

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    // The default here would be SettingsManager.create(cwd, agentDir), which
    // reads ~/.pi/agent/settings.json and with it the legacy system's packages.
    settingsManager: SettingsManager.inMemory(),
    model: getBuiltinModel(SDK_MODEL.provider, SDK_MODEL.id),
    noTools: 'all'
    // agentDir stays default — that is the whole of "credentials only".
  })

  return session
}

/** Stop the work and let go of the session, in that order. */
function closeSession(session: AgentSession): void {
  void (async () => {
    try {
      await session.abort()
    } catch {
      // Nothing left to tell: the adapter that owned this session has already
      // stopped speaking for it.
    }
    try {
      session.dispose()
    } catch {
      // Same.
    }
  })()
}

export function createSdkAdapter(): AgentAdapter {
  const listeners = new Set<PortEventListener>()
  const running = new Set<Turn>()
  let slot: SessionSlot | undefined
  let turns = 0

  function emit(event: PortEvent): void {
    // A copy, so a listener that unsubscribes while being called does not
    // disturb the delivery of that same event to the others.
    for (const listener of [...listeners]) listener(event)
  }

  function ensureSession(): Promise<AgentSession> {
    const existing = slot
    if (existing !== undefined) return existing.session

    const opening: SessionSlot = {
      dropped: false,
      session: openSession().then((session) => {
        if (opening.dropped) {
          closeSession(session)
          throw new Error('The session was disposed before it finished opening.')
        }
        return session
      })
    }
    slot = opening
    // The first session is opened before anything prompts, so its failure may
    // have no waiter at all — it is held here and told to the first turn.
    opening.session.catch(() => undefined)
    return opening.session
  }

  function dropSession(): void {
    const dropped = slot
    slot = undefined
    if (dropped === undefined) return
    dropped.dropped = true
    dropped.session.then(closeSession, () => undefined)
  }

  function finished(turn: Turn): void {
    turn.unsubscribe?.()
    turn.unsubscribe = undefined
    running.delete(turn)
  }

  /** Exactly one `turn_started` per turn, and always before anything else. */
  function start(turn: Turn): void {
    if (turn.started) return
    turn.started = true
    emit({ type: 'turn_started', turnId: turn.id })
  }

  /** A turn's one terminal event: the first one to arrive closes the turn. */
  function settle(turn: Turn, event: PortEvent): void {
    if (turn.settled || turn.abandoned) return
    start(turn)
    turn.settled = true
    emit(event)
    finished(turn)
  }

  function fail(turn: Turn, cause: unknown): void {
    // The cause itself stops here: what the pane is told is `adapterError`'s
    // business, and it is the same rule a failed SDK event goes through.
    settle(turn, adapterError(turn.id, cause))
  }

  /**
   * One mapped SDK event, folded into the turn. Deltas are the only thing the
   * stream puts on the port directly; how the turn ends is remembered and said
   * once, by `run`, when the SDK has finished with the prompt.
   */
  function relay(turn: Turn, event: PortEvent): void {
    if (turn.settled || turn.abandoned) return
    switch (event.type) {
      case 'turn_started':
        start(turn)
        return
      case 'text_delta':
        start(turn)
        // Text arriving after a failed message is the SDK's own retry
        // succeeding: the turn is no longer failing, and the recovered reply is
        // the reply.
        turn.outcome = { type: 'turn_ended', turnId: turn.id }
        emit(event)
        return
      case 'turn_ended':
        // The end of an SDK turn, which is not the end of the port's: the SDK
        // emits one after a failed message and another after each retry or
        // compaction of the same prompt. `prompt()` returning is the only end
        // this port believes.
        return
      default:
        // A failure the SDK reported as an event. Remembered, not emitted: if
        // it is transient the SDK retries behind the port, and only its last
        // word counts.
        turn.outcome = event
    }
  }

  async function run(turn: Turn, text: string): Promise<void> {
    let session: AgentSession
    try {
      session = await ensureSession()
    } catch (cause) {
      // Either the session could never be opened, or it was dropped while this
      // turn was waiting for it. Nothing was sent anywhere in either case.
      if (!turn.abandoned) fail(turn, cause)
      finished(turn)
      return
    }
    if (turn.abandoned) {
      finished(turn)
      return
    }

    turn.unsubscribe = session.subscribe((event) => {
      const mapped = toPortEvent(event, turn.id)
      if (mapped === undefined) return
      relay(turn, mapped)
    })

    try {
      await session.prompt(text)
      // The paid work is over — including any retry the SDK ran by itself — so
      // this is where the turn ends, with whatever the stream last said about
      // how it was going: `turn_ended`, or the failure it never recovered from.
      settle(turn, turn.outcome)
    } catch (cause) {
      fail(turn, cause)
    } finally {
      finished(turn)
    }
  }

  // Opened here, at startup, rather than on the first prompt: a session that
  // cannot be created at all is a launch-time fact, and the first turn is only
  // where it can be said out loud.
  void ensureSession()

  return {
    prompt(text: string): Promise<TurnId> {
      turns += 1
      const id: TurnId = `t-${turns}`
      const turn: Turn = {
        id,
        started: false,
        settled: false,
        abandoned: false,
        outcome: { type: 'turn_ended', turnId: id },
        unsubscribe: undefined
      }
      running.add(turn)
      // Accepted, not finished: the id is answered now and the turn streams on.
      void run(turn, text)
      return Promise.resolve(turn.id)
    },

    onEvent(listener: PortEventListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    // Subscriptions are left alone: whoever is listening keeps listening, and
    // hears the next turn in full. What is dropped is the work.
    dispose(): void {
      for (const turn of [...running]) {
        turn.abandoned = true
        finished(turn)
      }
      running.clear()
      dropSession()
    }
  }
}
