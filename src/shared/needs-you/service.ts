import type { SessionId } from '../agent/port'

// The needs-you state's two channels outside the window: the dock badge and
// one banner per finished session. The sidebar mark is the document's own
// business and never comes through here.
//
// The renderer reports facts — how many are waiting, and that one just
// finished. Whether either reaches the user is main's call, because main is
// what knows whether the window has focus, and main is what owns the dock.

/** What a banner says, and what clicking it opens. */
export interface WaitingSession {
  readonly sessionId: SessionId
  /** The workspace's name, which is line one of the banner. */
  readonly workspace: string
  /** The session's title, which is line two. */
  readonly title: string
  // The question, when a question is what the session needs the user for.
  // The banner names it: being called away is worth it for a decision, and
  // the decision is what they are being called to make.
  readonly asks?: string
}

export interface NeedsYouService {
  /** How many sessions are waiting on the user now. Zero clears the badge. */
  waiting(count: number): Promise<void>
  /**
   * One session needs the user: its turn finished, or its agent asked. At
   * most one banner comes of it, sounding unless a banner just before it
   * already did.
   */
  announce(session: WaitingSession): Promise<void>
}
