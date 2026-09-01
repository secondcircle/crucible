import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentPort, PanelState, PanelTab, SessionId, TabId } from '../../../shared/agent/port'
import { AddressRow } from './AddressRow'
import { guestSrc, shownLocation } from './exhibit-location'
import { Markdown } from './Markdown'
import './context-panel.css'

// Every tab fact comes from the snapshot and every user action goes back
// through the port, so the model and this view cannot disagree about what is open.

/** Below this the panel stops being readable. */
const MIN_PANEL = 280

/** What the chat column keeps for itself, whatever the divider is dragged to. */
const MIN_CHAT = 320

/** What a session with tabs shows before the user has resized anything. */
const DEFAULT_PANEL_WIDTH = '44%'

/** As much of Electron's WebviewTag as the panel calls. */
interface ExhibitWebview extends HTMLElement {
  reload(): void
}

/** Electron's in-place navigation events, as much of one as the row reads. */
interface GuestNavigation extends Event {
  readonly url: string
}

/** A link click, a redirect and a history push, in that order of likelihood. */
const GUEST_NAVIGATION = ['did-navigate', 'did-navigate-in-page'] as const

/** The one mounted exhibit: the guest's React key, and the owner of the state below. */
type ExhibitMount = string

function mountOf(sessionId: SessionId, tab: PanelTab): ExhibitMount {
  return `${sessionId}:${tab.id}:${tab.shownAt}`
}

/** What the user has done to the mounted exhibit since it mounted. */
interface LiveExhibit {
  readonly of: ExhibitMount
  /** Refresh clicks against this mount. A markdown tab re-reads on every bump. */
  readonly refreshes: number
  /** Where a url guest navigated in place; absent until it does. */
  readonly navigated?: string
}

export function ContextPanel({
  panel,
  sessionId,
  width,
  port,
  onCopyLocation,
  onResize,
  onCollapse
}: {
  readonly panel: PanelState
  readonly sessionId: SessionId
  /** Pixels once the divider has been dragged; the default until then. */
  readonly width?: number
  readonly port: AgentPort
  /** Writes the whole location to the system clipboard. The row says so itself. */
  readonly onCopyLocation: (location: string) => void
  readonly onResize: (width: number) => void
  readonly onCollapse: () => void
}): React.JSX.Element {
  const active = panel.tabs.find((tab) => tab.id === panel.activeTabId)
  // Set for as long as a drag is under way, so a panel that goes away
  // mid-drag takes its listeners with it.
  const endDrag = useRef<(() => void) | undefined>(undefined)
  const divider = useRef<HTMLDivElement>(null)
  // The mounted exhibit guest, for the refresh control alone.
  const viewRef = useRef<ExhibitWebview | null>(null)
  const [held, setHeld] = useState<LiveExhibit>({ of: '', refreshes: 0 })

  useEffect(() => () => endDrag.current?.(), [])

  // Whatever the user did to another mount died with it: a fresh mount reads as
  // untouched in the same frame it appears, with no effect and no stale frame.
  const mount = active === undefined ? undefined : mountOf(sessionId, active)
  const live: LiveExhibit =
    mount !== undefined && held.of === mount ? held : { of: mount ?? '', refreshes: 0 }

  function refresh(): void {
    if (active === undefined || mount === undefined) return
    if (active.kind === 'markdown') {
      // Main reads the file at call time, so a bumped generation is the whole
      // of a re-read.
      setHeld({ ...live, of: mount, refreshes: live.refreshes + 1 })
      return
    }
    const shown = viewRef.current
    // The guest is reloaded and never remounted: a remount would load the
    // address the agent showed rather than the page the guest is showing.
    // Absent under jsdom, where <webview> is an unknown element.
    if (shown !== null && typeof shown.reload === 'function') shown.reload()
  }

  function navigate(url: string): void {
    if (mount === undefined) return
    setHeld({ of: mount, refreshes: live.refreshes, navigated: url })
  }

  function startDrag(pressed: React.MouseEvent): void {
    if (endDrag.current !== undefined) return
    // Without this the press begins a native selection drag, which is what
    // takes the col-resize cursor away and highlights text while resizing.
    pressed.preventDefault()
    const body = document.body
    const selection = body.style.userSelect
    body.style.userSelect = 'none'
    // An exhibit frame is a window of its own and would take the pointer the
    // moment the drag passed over it, stranding the divider mid-drag.
    const panel = divider.current?.nextElementSibling as HTMLElement | null
    const pointers = panel?.style.pointerEvents ?? ''
    if (panel !== null && panel !== undefined) panel.style.pointerEvents = 'none'

    function onMove(moved: MouseEvent): void {
      // Measured from the row rather than the window, which would let the
      // panel claim the sidebar's width and clip the surplus off screen.
      const line = divider.current?.getBoundingClientRect().width ?? 0
      const right = divider.current?.parentElement?.getBoundingClientRect().right ?? 0
      const chat = divider.current?.previousElementSibling ?? null
      const chatLeft = chat === null ? 0 : chat.getBoundingClientRect().left
      const room = Math.max(MIN_PANEL, right - chatLeft - line - MIN_CHAT)
      onResize(Math.max(MIN_PANEL, Math.min(right - moved.clientX, room)))
    }

    function onUp(): void {
      endDrag.current = undefined
      body.style.userSelect = selection
      if (panel !== null && panel !== undefined) panel.style.pointerEvents = pointers
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    endDrag.current = onUp
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <>
      {/* A hit area wider than the line it draws, so the drag is catchable. */}
      <div
        className="divider"
        role="separator"
        aria-label="Resize context panel"
        aria-orientation="vertical"
        ref={divider}
        onMouseDown={startDrag}
      />

      <aside
        className="ctx"
        aria-label="Context panel"
        style={{ width: width === undefined ? DEFAULT_PANEL_WIDTH : `${width}px` }}
      >
        <div className="tabstrip" role="tablist" aria-label="Context panel tabs">
          {panel.tabs.map((tab) => (
            // A div rather than a button: the close control is a button of its
            // own and one cannot sit inside the other.
            <div
              key={tab.id}
              className={tab.id === panel.activeTabId ? 'tab active' : 'tab'}
              role="tab"
              tabIndex={0}
              aria-selected={tab.id === panel.activeTabId}
              onClick={() => void port.activateTab(sessionId, tab.id)}
              onKeyDown={(pressed) => {
                if (pressed.key !== 'Enter' && pressed.key !== ' ') return
                pressed.preventDefault()
                void port.activateTab(sessionId, tab.id)
              }}
            >
              <span className="kind">
                {tab.kind === 'html' ? 'html' : tab.kind === 'url' ? 'web' : 'md'}
              </span>
              <span className="ttitle">{tab.title}</span>
              <button
                className="x"
                aria-label={`Close ${tab.title}`}
                onClick={(clicked) => {
                  // The click closes the tab and does not also switch to it.
                  clicked.stopPropagation()
                  void port.closeTab(sessionId, tab.id)
                }}
              >
                ×
              </button>
            </div>
          ))}
          <div className="strip-tools">
            <button className="stool" aria-label="Collapse context panel" onClick={onCollapse}>
              ⇥
            </button>
          </div>
        </div>

        {/* Where the active tab's exhibit is, and the panel's one refresh
            control. Between the strip and the exhibit, at every width. */}
        {active === undefined ? null : (
          <AddressRow
            location={shownLocation(active, live.navigated)}
            onCopy={onCopyLocation}
            onRefresh={refresh}
          />
        )}

        <Exhibit
          sessionId={sessionId}
          tab={active}
          port={port}
          refreshes={live.refreshes}
          viewRef={viewRef}
          onNavigate={navigate}
        />
      </aside>
    </>
  )
}

export function PanelEdge({
  count,
  onOpen
}: {
  readonly count: number
  readonly onOpen: () => void
}): React.JSX.Element {
  return (
    <button className="edge" aria-label="Open context panel" onClick={onOpen}>
      <span className="elabel">Context</span>
      <span className="ecount">{count}</span>
    </button>
  )
}

function Exhibit({
  sessionId,
  tab,
  port,
  refreshes,
  viewRef,
  onNavigate
}: {
  readonly sessionId: SessionId
  readonly tab: PanelTab | undefined
  readonly port: AgentPort
  /** Bumped by a refresh click; a markdown exhibit re-reads on every bump. */
  readonly refreshes: number
  readonly viewRef: React.RefObject<ExhibitWebview | null>
  /** Where a url guest went in place. Never called for a file tab. */
  readonly onNavigate: (url: string) => void
}): React.JSX.Element {
  // Held in a ref so the ref callback below keeps one identity across renders:
  // React tears a ref's subscription down whenever that identity changes.
  const notify = useRef(onNavigate)
  useEffect(() => {
    notify.current = onNavigate
  })

  // A file tab's row names the file that was read, whatever its guest does, so
  // only a url guest is listened to at all.
  const follows = tab?.kind === 'url'
  const mounted = useCallback(
    (guest: HTMLElement | null) => {
      viewRef.current = guest as ExhibitWebview | null
      if (guest === null || !follows) return
      const went = (event: Event): void => {
        const { url } = event as GuestNavigation
        if (typeof url === 'string' && url !== '') notify.current(url)
      }
      for (const type of GUEST_NAVIGATION) guest.addEventListener(type, went)
      return () => {
        for (const type of GUEST_NAVIGATION) guest.removeEventListener(type, went)
        viewRef.current = null
      }
    },
    [viewRef, follows]
  )

  return (
    <div className="exhibit">
      {tab === undefined ? null : tab.kind === 'markdown' ? (
        <MarkdownExhibit sessionId={sessionId} tab={tab} port={port} refreshes={refreshes} />
      ) : (
        // A guest webContents of its own: full browser fidelity — scripts run,
        // the network loads, links navigate in place — and no preload, no
        // node, no reach into the app.

        // `shownAt` is in the key so a re-show remounts and reloads; a refresh
        // is not in it, because reloading the guest is not remounting it.
        <webview
          key={mountOf(sessionId, tab)}
          className="frame"
          title={tab.title}
          src={guestSrc(tab)}
          ref={mounted}
        />
      )}
    </div>
  )
}

/** One answer to one read of one mount. */
interface ExhibitRead {
  readonly of: ExhibitMount
  /** The refresh generation this read was asked at. */
  readonly at: number
  readonly answer:
    | { readonly kind: 'body'; readonly markdown: string }
    | { readonly kind: 'failure'; readonly message: string }
}

// A markdown exhibit's body is fetched through the port and never off the disk.
function MarkdownExhibit({
  sessionId,
  tab,
  port,
  refreshes
}: {
  readonly sessionId: SessionId
  readonly tab: Extract<PanelTab, { readonly kind: 'markdown' }>
  readonly port: AgentPort
  readonly refreshes: number
}): React.JSX.Element | null {
  const [read, setRead] = useState<ExhibitRead | undefined>(undefined)

  const tabId: TabId = tab.id
  // A re-show refreshes the tab in place, and that is what a changed `shownAt`
  // means for the view: the same tab, fetched again.
  const of = mountOf(sessionId, tab)

  // Which mount a landing answer is allowed to speak for. Written before the
  // read below is asked for, so a read of the mount just left is discarded
  // rather than painted under the tab that replaced it.
  const showing = useRef(of)
  useEffect(() => {
    showing.current = of
  }, [of])

  useEffect(() => {
    void port
      .exhibit(sessionId, tabId)
      .then(({ body }) => {
        if (showing.current === of) {
          setRead(newest({ of, at: refreshes, answer: { kind: 'body', markdown: body } }))
        }
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause)
        if (showing.current === of) {
          setRead(newest({ of, at: refreshes, answer: { kind: 'failure', message } }))
        }
      })
  }, [port, sessionId, tabId, of, refreshes])

  // Nothing of another tab is ever shown under this one's title, and the body
  // already on screen stays until a newer answer lands: a refresh replaces
  // content, it never blanks the exhibit first.
  const shown = read?.of === of ? read.answer : undefined
  if (shown === undefined) return null
  // The tab stays open whatever a failure says: curation is the agent's.
  if (shown.kind === 'failure') return <p className="exhibit-failure">{shown.message}</p>
  return (
    <div className="mdview">
      <Markdown markdown={shown.markdown} />
    </div>
  )
}

// Two ⟳ clicks put two reads of one file in flight, and the older one may land
// last. The newest read that has come back wins, never the last to arrive.
function newest(landed: ExhibitRead): (held: ExhibitRead | undefined) => ExhibitRead {
  return (held) =>
    held !== undefined && held.of === landed.of && held.at > landed.at ? held : landed
}
