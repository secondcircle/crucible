import type { SessionId } from '../../../shared/agent/port'

// What a session's jump is doing, held per session because a summarize takes
// real seconds and the user is free to go and work somewhere else while it
// runs. Nothing here is window-global: session A summarizing puts nothing at
// all in session B.

export type JumpState =
  /** A plain jump in flight. */
  | { readonly kind: 'jumping'; readonly ref: string }
  /** The summarize call is running: π is paying for an LLM call. */
  | { readonly kind: 'summarizing'; readonly ref: string }
  /** π scheduled one of its own retries, and said why. */
  | {
      readonly kind: 'retrying'
      readonly ref: string
      readonly attempt: number
      readonly maxAttempts: number
      readonly message: string
    }
  /** Escape was pressed; the port has not answered yet. */
  | { readonly kind: 'cancelling'; readonly ref: string }
  // π's retries are exhausted and nothing moved. The one kind that outlives
  // the call: it is still there when the user comes back to the session.
  | { readonly kind: 'failed'; readonly ref: string; readonly message: string }

export type Jumps = Readonly<Record<SessionId, JumpState>>

export function jumpOf(jumps: Jumps, sessionId: SessionId | undefined): JumpState | undefined {
  return sessionId === undefined ? undefined : jumps[sessionId]
}

export function withJump(jumps: Jumps, sessionId: SessionId, state: JumpState): Jumps {
  return { ...jumps, [sessionId]: state }
}

export function withoutJump(jumps: Jumps, sessionId: SessionId): Jumps {
  if (jumps[sessionId] === undefined) return jumps
  const rest = { ...jumps }
  delete rest[sessionId]
  return rest
}

/** A jump is under way, so every jump action in the tree is refused. */
export function jumpBusy(state: JumpState | undefined): boolean {
  return state !== undefined && state.kind !== 'failed'
}

// Only a summarize can be cancelled: a plain jump has no LLM call to abort,
// and asking twice is not an escalation.
export function jumpCancellable(state: JumpState | undefined): boolean {
  return state?.kind === 'summarizing' || state?.kind === 'retrying'
}

/** The failure the tree and the banner both say, in the same words. */
export function summaryFailure(message: string): string {
  return `Summary failed — ${message}. Nothing moved; press s to try again.`
}

/** The one line the overlay's action note shows for this state. */
export function jumpNote(state: JumpState): string {
  switch (state.kind) {
    case 'jumping':
      return 'Jumping…'
    case 'summarizing':
      return 'Summarizing the branch you are leaving…'
    case 'retrying':
      return `${state.message} — retrying (${state.attempt} of ${state.maxAttempts})`
    case 'cancelling':
      return 'Cancelling…'
    case 'failed':
      return summaryFailure(state.message)
  }
}
