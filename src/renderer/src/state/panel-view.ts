import type { PanelState, SessionId, SessionState } from '../../../shared/agent/port'

// How each session's context panel is shown, and every rule that moves it.
// Pure: no React, no DOM, no port. The document holds the record and this
// module decides what a gesture or an event does to it.

/**
 * How a session's panel is shown. Exclusive by construction: collapsed and
 * maximized are two values of one field, so they can never both be true.
 */
export type PanelView = 'split' | 'collapsed' | 'maximized'

/**
 * What each session's panel view is, for this launch and no longer. `split`
 * is the absence of an entry rather than a value, so one fact has one
 * representation and nothing has to keep two of them agreeing.
 */
export type PanelViews = Readonly<Record<SessionId, Exclude<PanelView, 'split'>>>

/** A session nothing is remembered for is split. */
export function panelViewOf(views: PanelViews, sessionId: SessionId | undefined): PanelView {
  if (sessionId === undefined) return 'split'
  return views[sessionId] ?? 'split'
}

/** The one writer. Setting `split` drops the entry; every other view stores it. */
export function withPanelView(
  views: PanelViews,
  sessionId: SessionId,
  view: PanelView
): PanelViews {
  if (view === 'split') {
    if (views[sessionId] === undefined) return views
    const rest: Record<SessionId, Exclude<PanelView, 'split'>> = { ...views }
    delete rest[sessionId]
    return rest
  }
  if (views[sessionId] === view) return views
  return { ...views, [sessionId]: view }
}

/**
 * What a `panel_shown` does to the session it happened in: a collapsed panel
 * opens, as it does today, and a maximized one stays maximized (R47). No other
 * event moves a view.
 */
export function withShownTab(views: PanelViews, sessionId: SessionId): PanelViews {
  if (views[sessionId] !== 'collapsed') return views
  return withPanelView(views, sessionId, 'split')
}

/**
 * Drops every entry that no longer describes a panel: a session that has left
 * the sidebar, and a session whose panel has no tabs. Returns the record it
 * was given when it drops nothing.
 */
export function forgetEmptyPanels(
  views: PanelViews,
  sessions: readonly SessionState[]
): PanelViews {
  const withPanels = new Set(
    sessions.filter((session) => hasTabs(session.panel)).map((session) => session.id)
  )
  const kept = Object.entries(views).filter(([sessionId]) => withPanels.has(sessionId))
  if (kept.length === Object.keys(views).length) return views
  return Object.fromEntries(kept) as PanelViews
}

/** What the panel area shows for one session: the view, or nothing at all. */
export type PanelPlace = 'none' | 'collapsed' | 'split' | 'maximized'

/**
 * A session with no tabs has no panel, whatever is remembered for it. Read
 * together with the snapshot, so the frame between the last tab closing and
 * the memory being pruned already shows the ordinary no-tabs view (R42).
 */
export function panelPlace(panel: PanelState | undefined, view: PanelView): PanelPlace {
  if (!hasTabs(panel)) return 'none'
  return view
}

function hasTabs(panel: PanelState | undefined): boolean {
  return panel !== undefined && panel.tabs.length > 0
}
