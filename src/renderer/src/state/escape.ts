// Escape's precedence, as a function of what is up rather than as a chain of
// conditions in a handler. Two callers read it — the window's keydown and a
// key that came out of an exhibit guest — so encoding it twice is how they
// would drift. Pure: the document keeps the effects and performs the rung.

/** Where a press came from. An exhibit guest's keys are not the window's. */
export type EscapeSource = 'window' | 'exhibit'

/** The one thing an Escape does, or nothing. Ordered as the ladder is. */
export type EscapeRung =
  | 'closeLogin'
  | 'answerExpiryChoice'
  | 'closeConfirm'
  | 'closePopover'
  | 'closeCommandPopover'
  | 'closeFilePopover'
  | 'leaveGraphFullScreen'
  | 'closeArtifactReader'
  | 'unmaximizePanel'
  | 'cancelSummarize'
  | 'closeTopOfRegion'
  | 'cancelTurn'
  /** Nothing above matched. From the window this is the accelerator's press. */
  | 'none'

/** Everything the ladder consults, and nothing else. */
export interface EscapeState {
  readonly loginOpen: boolean
  readonly expiryChoiceOpen: boolean
  readonly confirmOpen: boolean
  readonly popoverOpen: boolean
  readonly commandPopoverOpen: boolean
  readonly filePopoverOpen: boolean
  /** The run graph over the whole body, which implies a run in the region. */
  readonly graphFullScreen: boolean
  readonly artifactReaderOpen: boolean
  /** The panel as it is drawn, not as it is remembered. */
  readonly panelMaximized: boolean
  /** The active session's summarize, and only if it can still be cancelled. */
  readonly summarizeCancellable: boolean
  readonly treeOpen: boolean
  readonly regionOccupied: boolean
  readonly turnCancellable: boolean
}

/**
 * Which surface this press takes off. One function, because precedence is a
 * fact about the app and two callers now read it: the window's keydown and an
 * Escape that came out of an exhibit guest.
 *
 * A full-screen surface comes off before a turn is cancelled: the run graph's,
 * and a maximized context panel. Escape means stop only once nothing is
 * covering the session.
 *
 * From an exhibit the answer is `unmaximizePanel` or `none`: a page's Escape
 * frees the user from a maximized panel they clicked into and does nothing
 * else, ever.
 */
export function escapeRung(source: EscapeSource, state: EscapeState): EscapeRung {
  const rung = windowRung(state)
  if (source === 'window') return rung
  return rung === 'unmaximizePanel' ? 'unmaximizePanel' : 'none'
}

function windowRung(state: EscapeState): EscapeRung {
  // The login dialog sits above the Settings card it was launched from, so it
  // closes first and lands back on Providers.
  if (state.loginOpen) return 'closeLogin'
  // The cache expiry choice is an answer owed to a send, so it comes off
  // before anything under it.
  if (state.expiryChoiceOpen) return 'answerExpiryChoice'
  // A confirm is an answer to a click, not a navigation: it stacks above
  // whatever is up and comes off first.
  if (state.confirmOpen) return 'closeConfirm'
  if (state.popoverOpen) return 'closePopover'
  if (state.commandPopoverOpen) return 'closeCommandPopover'
  if (state.filePopoverOpen) return 'closeFilePopover'
  // The graph over the whole body covers the reader as well as the transcript,
  // so it is the first layer to come off.
  if (state.graphFullScreen) return 'leaveGraphFullScreen'
  // An artifact is read above the run that lists it, so it comes off before
  // the region unwinds a surface.
  if (state.artifactReaderOpen) return 'closeArtifactReader'
  // The maximized panel is full screen over everything but the sidebar, so it
  // comes off before a summarize or a turn is stopped — and after every
  // overlay, which is what the region guard says: an overlay opened over a
  // maximized panel closes first and the panel stays as it was.
  if (state.panelMaximized && !state.regionOccupied) return 'unmaximizePanel'
  // A summarize is this session's own work and Escape stops it, whether or not
  // the tree that started it is still on screen. It comes off before the tree
  // and after every other occupant, which is the order the surfaces themselves
  // are stacked in.
  if ((!state.regionOccupied || state.treeOpen) && state.summarizeCancellable) {
    return 'cancelSummarize'
  }
  // The region's topmost surface, whichever it is — which unwinds an opened
  // run back onto the overview it was opened from. While anything occupies the
  // region Escape never cancels a turn.
  if (state.regionOccupied) return 'closeTopOfRegion'
  if (state.turnCancellable) return 'cancelTurn'
  return 'none'
}
