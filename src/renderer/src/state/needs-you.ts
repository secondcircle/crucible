import type { SessionId, SessionState, ShellSnapshot } from '../../../shared/agent/port'

// A session whose turn ended while the user was not looking at it needs them.
// Everything about that state is decided here, so the rules are readable in
// one place and testable without a document.
//
// The marks live as long as the launch does and no longer: nothing runs while
// Crucible is closed, so there is nothing to remember across a restart.

/** What the sidebar shows and what Tab walks. Order is rail order. */
export type Marks = ReadonlySet<SessionId>

/**
 * Whether a turn that just finished leaves its session asking.
 *
 * Looking is per window, not per session: a turn that ends while Crucible is
 * behind another app was not watched, whichever session was on screen.
 */
export function finishedUnwatched(
  sessionId: SessionId,
  looking: { readonly activeSessionId?: SessionId; readonly windowFocused: boolean }
): boolean {
  return !looking.windowFocused || sessionId !== looking.activeSessionId
}

// The sidebar's own order: workspaces top to bottom, and within each the
// sessions it lists. Tab walks this, so the key goes where the eye would.
export function railOrder(snapshot: ShellSnapshot): readonly SessionState[] {
  return snapshot.workspaces.flatMap((workspace) =>
    snapshot.sessions.filter((session) => session.workspaceId === workspace.id)
  )
}

/**
 * The topmost session asking, or nothing at all.
 *
 * Always the topmost rather than the one after the current: landing clears a
 * mark, so pressing Tab repeatedly empties the queue from the top down, and
 * crosses into the next workspace when this one is clear.
 */
export function nextAsking(snapshot: ShellSnapshot, marks: Marks): SessionState | undefined {
  return railOrder(snapshot).find((session) => marks.has(session.id))
}

/** The total, which is what the dock badge carries. */
export function askingCount(sessions: readonly SessionState[], marks: Marks): number {
  return sessions.filter((session) => marks.has(session.id)).length
}

// A mark for a session that is no longer in the sidebar is not a mark at all:
// removing a session takes its mark with it, and so does forgetting the
// workspace it lived in.
export function forgetGone(marks: Marks, sessions: readonly SessionState[]): Marks {
  const live = new Set(sessions.map((session) => session.id))
  const kept = [...marks].filter((id) => live.has(id))
  return kept.length === marks.size ? marks : new Set(kept)
}

export function withMark(marks: Marks, sessionId: SessionId): Marks {
  if (marks.has(sessionId)) return marks
  return new Set([...marks, sessionId])
}

export function withoutMark(marks: Marks, sessionId: SessionId): Marks {
  if (!marks.has(sessionId)) return marks
  const next = new Set(marks)
  next.delete(sessionId)
  return next
}
