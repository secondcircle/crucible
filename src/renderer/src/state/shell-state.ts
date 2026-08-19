import type {
  ModelInfo,
  PortEvent,
  SessionId,
  ShellSnapshot,
  TranscriptItem,
  TurnId
} from '../../../shared/agent/port'

/**
 * Everything the shell knows, and every way it can change: one value and one
 * pure function.
 *
 * The reducer is where the port's turn contract becomes what a person sees, so
 * the rules it keeps are worth naming:
 *
 * - **A session's items are built from its own events only.** Every event
 *   carries its session, so two sessions streaming at once never touch each
 *   other's transcript (A18) and switching away loses nothing.
 * - **A turn's events are ignored unless that turn is the session's live one.**
 *   After a terminal event the session has no live turn, so anything arriving
 *   late for it changes nothing — the renderer's own half of "nothing after the
 *   terminal event".
 * - **Arrival order is item order.** Text after a tool or a thought opens a new
 *   text block rather than growing the previous one (TR-3), which is what makes
 *   a transcript read as the sequence that actually happened.
 * - **Time is an input, never a reading.** Nothing here calls `Date.now`: the
 *   caller stamps each event, so the reducer is pure and React may replay it
 *   under `StrictMode` without the elapsed times drifting.
 */

/** One rendered item. The port's transcript items, plus what is still moving. */
export type ViewItem =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'assistant'; readonly markdown: string; readonly streaming: boolean }
  | {
      readonly kind: 'thinking'
      readonly text: string
      readonly seconds?: number
      readonly running: boolean
      /** When the block began, so its duration is measured and not guessed. */
      readonly startedAt?: number
    }
  | {
      readonly kind: 'tool'
      readonly callId?: string
      readonly name: string
      readonly summary: string
      readonly output: string
      readonly ok?: boolean
      readonly running: boolean
    }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'error'; readonly message: string }

/** What the renderer holds for one session it has seen this launch. */
export interface SessionView {
  readonly items: readonly ViewItem[]
  /** Whether settled history has been fetched, or the session is live-only. */
  readonly loaded: boolean
  /** The live turn and when it was observed to start (TR-6). */
  readonly turn?: { readonly turnId: TurnId; readonly startedAt: number }
}

export interface ShellState {
  readonly snapshot: ShellSnapshot
  readonly models: readonly ModelInfo[]
  readonly views: Readonly<Record<SessionId, SessionView>>
}

export const NOTHING_YET: ShellState = {
  snapshot: { workspaces: [], sessions: [] },
  models: [],
  views: {}
}

export type ShellAction =
  | { readonly type: 'snapshot'; readonly snapshot: ShellSnapshot }
  | { readonly type: 'models'; readonly models: readonly ModelInfo[] }
  | {
      readonly type: 'loaded'
      readonly sessionId: SessionId
      readonly items: readonly TranscriptItem[]
    }
  | { readonly type: 'sent'; readonly sessionId: SessionId; readonly text: string }
  /** Session reset: the identity stands, the conversation behind it is new. */
  | { readonly type: 'reset'; readonly sessionId: SessionId }
  | { readonly type: 'event'; readonly event: PortEvent; readonly at: number }

const EMPTY_VIEW: SessionView = { items: [], loaded: false }

export function reduce(state: ShellState, action: ShellAction): ShellState {
  switch (action.type) {
    case 'snapshot':
      return { ...state, snapshot: action.snapshot }

    case 'models':
      return { ...state, models: action.models }

    case 'loaded': {
      const view = state.views[action.sessionId] ?? EMPTY_VIEW
      // History is what the session had before this launch watched it, so live
      // items already gathered stay where they are, after it.
      return withView(state, action.sessionId, {
        ...view,
        loaded: true,
        items: [...action.items.map(restored), ...view.items]
      })
    }

    case 'reset':
      // Nothing of the old conversation survives here, because nothing of it is
      // in the new one: it was detached, not cleared (A25).
      return withView(state, action.sessionId, { items: [], loaded: true })

    case 'sent': {
      const view = state.views[action.sessionId] ?? EMPTY_VIEW
      return withView(state, action.sessionId, {
        ...view,
        items: [...view.items, { kind: 'user', text: action.text }]
      })
    }

    case 'event':
      return heard(state, action.event, action.at)
  }
}

/** A settled item, as the renderer holds it: nothing about it is still moving. */
function restored(item: TranscriptItem): ViewItem {
  switch (item.kind) {
    case 'assistant':
      return { kind: 'assistant', markdown: item.markdown, streaming: false }
    case 'thinking':
      return { kind: 'thinking', text: item.text, seconds: item.seconds, running: false }
    case 'tool':
      return {
        kind: 'tool',
        name: item.name,
        summary: item.summary,
        output: item.output,
        ok: item.ok,
        running: false
      }
    default:
      return item
  }
}

function withView(state: ShellState, sessionId: SessionId, view: SessionView): ShellState {
  return { ...state, views: { ...state.views, [sessionId]: view } }
}

function heard(state: ShellState, event: PortEvent, at: number): ShellState {
  if (event.type === 'state') return { ...state, snapshot: event.snapshot }

  const { sessionId } = event
  const view = state.views[sessionId] ?? EMPTY_VIEW

  if (event.type === 'turn_started') {
    if (view.turn !== undefined) return state
    return withView(state, sessionId, {
      ...view,
      turn: { turnId: event.turnId, startedAt: at }
    })
  }

  // An event for anything but this session's live turn is stale, and a stale
  // event changes nothing.
  if (view.turn === undefined || view.turn.turnId !== event.turnId) return state

  switch (event.type) {
    case 'text_delta':
      return withView(state, sessionId, {
        ...view,
        items: appendText(view.items, event.delta, at)
      })

    case 'thinking_delta':
      return withView(state, sessionId, {
        ...view,
        items: appendThinking(view.items, event.delta, at)
      })

    case 'tool_started':
      return withView(state, sessionId, {
        ...view,
        items: [
          ...settle(view.items, at),
          {
            kind: 'tool',
            callId: event.callId,
            name: event.name,
            summary: event.summary,
            output: '',
            running: true
          }
        ]
      })

    case 'tool_output':
      return withView(state, sessionId, {
        ...view,
        items: mapCall(view.items, event.callId, (tool) => ({
          ...tool,
          output: tool.output + event.chunk
        }))
      })

    case 'tool_ended':
      return withView(state, sessionId, {
        ...view,
        items: mapCall(view.items, event.callId, (tool) => ({
          ...tool,
          // The final output is the whole of it, which is not always what the
          // chunks added up to: a tool that streamed nothing still has a result.
          output: event.output === '' ? tool.output : event.output,
          ok: event.ok,
          running: false
        }))
      })

    case 'turn_ended':
      return withView(state, sessionId, {
        ...view,
        turn: undefined,
        items: closeTurn(view.items, at)
      })

    case 'turn_cancelled':
      return withView(state, sessionId, {
        ...view,
        turn: undefined,
        // The partial output stands, closed by the quiet stopped marker (A4).
        items: [...closeTurn(view.items, at), { kind: 'stopped' }]
      })

    case 'turn_error':
      return withView(state, sessionId, {
        ...view,
        turn: undefined,
        items: [...closeTurn(view.items, at), { kind: 'error', message: event.message }]
      })
  }
}

/** Text grows the open text block, or opens one after anything else (TR-3). */
function appendText(items: readonly ViewItem[], delta: string, at: number): readonly ViewItem[] {
  const last = items[items.length - 1]
  if (last?.kind === 'assistant' && last.streaming) {
    return items.with(items.length - 1, { ...last, markdown: last.markdown + delta })
  }
  return [...settle(items, at), { kind: 'assistant', markdown: delta, streaming: true }]
}

/** Thinking grows the open thinking block, or opens one, timed from its first
 * delta so the duration shown is one the renderer measured (TH-1). */
function appendThinking(
  items: readonly ViewItem[],
  delta: string,
  at: number
): readonly ViewItem[] {
  const last = items[items.length - 1]
  if (last?.kind === 'thinking' && last.running) {
    return items.with(items.length - 1, { ...last, text: last.text + delta })
  }
  return [
    ...settle(items, at),
    { kind: 'thinking', text: delta, running: true, startedAt: at }
  ]
}

/** Close whatever was still moving: a text block stops streaming, a thought
 * gets the duration it actually took. */
function settle(items: readonly ViewItem[], at: number): readonly ViewItem[] {
  const last = items[items.length - 1]
  if (last === undefined) return items
  if (last.kind === 'assistant' && last.streaming) {
    return items.with(items.length - 1, { ...last, streaming: false })
  }
  if (last.kind === 'thinking' && last.running) {
    return items.with(items.length - 1, {
      ...last,
      running: false,
      // Measured, not guessed — and floored at a second, because a block that
      // took 400ms did take about a second as far as a reader is concerned and
      // "thought for 0s" says nothing at all.
      seconds:
        last.startedAt === undefined
          ? undefined
          : Math.max(1, Math.round((at - last.startedAt) / 1000))
    })
  }
  return items
}

/**
 * A turn is over: nothing more will arrive for it, so nothing of it may still
 * look like it is arriving. The open text or thinking block is closed, and a
 * tool that was running when the turn was cancelled stops spinning — with no
 * outcome, because it never reported one and this shell does not invent one.
 */
function closeTurn(items: readonly ViewItem[], at: number): readonly ViewItem[] {
  return settle(items, at).map((item) =>
    item.kind === 'tool' && item.running ? { ...item, running: false } : item
  )
}

/** Change the one tool item a call id names, and nothing else. */
function mapCall(
  items: readonly ViewItem[],
  callId: string,
  change: (tool: Extract<ViewItem, { kind: 'tool' }>) => ViewItem
): readonly ViewItem[] {
  const index = items.findIndex((item) => item.kind === 'tool' && item.callId === callId)
  const tool = index === -1 ? undefined : items[index]
  if (tool === undefined || tool.kind !== 'tool') return items
  return items.with(index, change(tool))
}
