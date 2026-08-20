import type {
  ImageAttachment,
  ModelInfo,
  PortEvent,
  SessionId,
  ShellSnapshot,
  TranscriptItem,
  TurnId
} from '../../../shared/agent/port'

// Time is an input, never a reading: the caller stamps each event, so React
// may replay this reducer under StrictMode without elapsed times drifting.

export type ViewItem =
  | {
      readonly kind: 'user'
      readonly text: string
      /** Only images that were genuinely sent with the message. */
      readonly images?: readonly ImageAttachment[]
    }
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
  | {
      readonly kind: 'bashRun'
      readonly command: string
      readonly output: string
      readonly exitCode?: number
    }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'error'; readonly message: string }

export interface SessionView {
  readonly items: readonly ViewItem[]
  /** Whether settled history has been fetched, or the session is live-only. */
  readonly loaded: boolean
  readonly turn?: { readonly turnId: TurnId; readonly startedAt: number }
}

// An unfetched view's items are `[]` whatever its conversation holds, so a
// caller guarding a destructive change must read ignorance as "not empty".
export function knownEmpty(view: SessionView | undefined): boolean {
  return view?.loaded === true && view.items.length === 0
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
  | {
      readonly type: 'sent'
      readonly sessionId: SessionId
      readonly text: string
      readonly images?: readonly ImageAttachment[]
    }
  | { readonly type: 'reset'; readonly sessionId: SessionId }
  // A jump replaced the conversation behind the identity: what this document
  // held of the abandoned path goes with it.
  | {
      readonly type: 'jumped'
      readonly sessionId: SessionId
      readonly items: readonly TranscriptItem[]
    }
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
      // Nothing of the old conversation survives here, because nothing of it
      // is in the new one: it was detached, not cleared.
      return withView(state, action.sessionId, { items: [], loaded: true })

    case 'jumped':
      // The session stands where the jump put it, so the whole view is the
      // path that was refetched and nothing of the old one survives.
      return withView(state, action.sessionId, {
        items: action.items.map(restored),
        loaded: true
      })

    case 'sent': {
      const view = state.views[action.sessionId] ?? EMPTY_VIEW
      return withView(state, action.sessionId, {
        ...view,
        items: [
          ...view.items,
          {
            kind: 'user',
            text: action.text,
            ...(action.images === undefined || action.images.length === 0
              ? {}
              : { images: action.images })
          }
        ]
      })
    }

    case 'event':
      return heard(state, action.event, action.at)
  }
}

function restored(item: TranscriptItem): ViewItem {
  switch (item.kind) {
    case 'user':
      return item.images === undefined
        ? { kind: 'user', text: item.text }
        : { kind: 'user', text: item.text, images: item.images }
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
    case 'bashRun':
    case 'stopped':
    case 'error':
      return item
  }
}

function withView(state: ShellState, sessionId: SessionId, view: SessionView): ShellState {
  return { ...state, views: { ...state.views, [sessionId]: view } }
}

function heard(state: ShellState, event: PortEvent, at: number): ShellState {
  if (event.type === 'state') return { ...state, snapshot: event.snapshot }
  // What a flush does is hand text back to the composer, which is the
  // document's business and not the transcript's.
  if (event.type === 'queue_flushed') return state
  // A shown tab is in the snapshot the `state` event before it carried; the
  // transcript has nothing to say about it.
  if (event.type === 'panel_shown') return state

  const { sessionId } = event
  const view = state.views[sessionId] ?? EMPTY_VIEW

  // A run that was genuinely added to the conversation is shown wherever the
  // session stands, because the delivery already happened: it is the one
  // announcement that does not belong to a turn this document is watching.
  if (event.type === 'bash_run_shared') {
    return withView(state, sessionId, {
      ...view,
      items: [
        ...settle(view.items, at),
        {
          kind: 'bashRun',
          command: event.command,
          output: event.output,
          ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode })
        }
      ]
    })
  }

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
    // A message the port delivered itself, which reads exactly as a sent one:
    // it appears here at its delivery point, never before it.
    case 'user_message':
      return withView(state, sessionId, {
        ...view,
        items: [...settle(view.items, at), { kind: 'user', text: event.text }]
      })

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
          // The final output is not always what the chunks added up to: a tool
          // that streamed nothing still has a result.
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
        // The partial output stands, closed by the quiet stopped marker.
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

// Text after a tool or a thought opens a new block instead of growing the last
// one, so the transcript reads as the sequence that happened.
function appendText(items: readonly ViewItem[], delta: string, at: number): readonly ViewItem[] {
  const last = items[items.length - 1]
  if (last?.kind === 'assistant' && last.streaming) {
    return items.with(items.length - 1, { ...last, markdown: last.markdown + delta })
  }
  return [...settle(items, at), { kind: 'assistant', markdown: delta, streaming: true }]
}

// Timed from the first delta, so the duration shown is one the renderer
// measured.
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
      // Floored at a second, because "thought for 0s" says nothing to a
      // reader.
      seconds:
        last.startedAt === undefined
          ? undefined
          : Math.max(1, Math.round((at - last.startedAt) / 1000))
    })
  }
  return items
}

// A tool still running when its turn ended stops spinning without an outcome,
// because it never reported one and none is invented here.
function closeTurn(items: readonly ViewItem[], at: number): readonly ViewItem[] {
  return settle(items, at).map((item) =>
    item.kind === 'tool' && item.running ? { ...item, running: false } : item
  )
}

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
