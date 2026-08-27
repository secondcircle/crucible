import { useEffect, useRef, useState } from 'react'
import type { AgentPort, PanelState, SessionId, TabId } from '../../../shared/agent/port'
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

export function ContextPanel({
  panel,
  sessionId,
  width,
  port,
  onResize,
  onCollapse
}: {
  readonly panel: PanelState
  readonly sessionId: SessionId
  /** Pixels once the divider has been dragged; the default until then. */
  readonly width?: number
  readonly port: AgentPort
  readonly onResize: (width: number) => void
  readonly onCollapse: () => void
}): React.JSX.Element {
  const active = panel.tabs.find((tab) => tab.id === panel.activeTabId)
  // Set for as long as a drag is under way, so a panel that goes away
  // mid-drag takes its listeners with it.
  const endDrag = useRef<(() => void) | undefined>(undefined)
  const divider = useRef<HTMLDivElement>(null)
  // The mounted exhibit guest, for the reload button alone.
  const viewRef = useRef<ExhibitWebview | null>(null)

  useEffect(() => () => endDrag.current?.(), [])

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
            {active !== undefined && active.kind !== 'markdown' ? (
              // For pages that do not reload themselves; a hot-reloading dev
              // server never needs it.
              <button
                className="stool"
                aria-label="Reload exhibit"
                onClick={() => {
                  const shown = viewRef.current
                  // Absent under jsdom, where <webview> is an unknown element.
                  if (shown !== null && typeof shown.reload === 'function') shown.reload()
                }}
              >
                ⟳
              </button>
            ) : null}
            <button className="stool" aria-label="Collapse context panel" onClick={onCollapse}>
              ⇥
            </button>
          </div>
        </div>

        <Exhibit sessionId={sessionId} tab={active} port={port} viewRef={viewRef} />
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
  viewRef
}: {
  readonly sessionId: SessionId
  readonly tab: PanelState['tabs'][number] | undefined
  readonly port: AgentPort
  readonly viewRef: React.RefObject<ExhibitWebview | null>
}): React.JSX.Element {
  return (
    <div className="exhibit">
      {tab === undefined ? null : tab.kind === 'markdown' ? (
        <MarkdownExhibit sessionId={sessionId} tab={tab} port={port} />
      ) : tab.src === undefined ? null : (
        // A guest webContents of its own: full browser fidelity — scripts run,
        // the network loads, links navigate in place — and no preload, no
        // node, no reach into the app.

        // `shownAt` is in the key so a re-show remounts and reloads.
        <webview
          key={`${sessionId}:${tab.id}:${tab.shownAt}`}
          className="frame"
          title={tab.title}
          src={tab.src}
          ref={(mounted) => {
            viewRef.current = mounted as ExhibitWebview | null
          }}
        />
      )}
    </div>
  )
}

// A markdown exhibit's body is fetched through the port and never off the disk.
function MarkdownExhibit({
  sessionId,
  tab,
  port
}: {
  readonly sessionId: SessionId
  readonly tab: PanelState['tabs'][number]
  readonly port: AgentPort
}): React.JSX.Element | null {
  const [shown, setShown] = useState<
    { readonly of: string; readonly body?: string; readonly failure?: string } | undefined
  >(undefined)

  const tabId: TabId = tab.id
  // A re-show refreshes the tab in place, and that is what a changed `shownAt`
  // means for the view: the same tab, fetched again.
  const of = `${sessionId}:${tabId}:${tab.shownAt}`

  useEffect(() => {
    let current = true
    void port
      .exhibit(sessionId, tabId)
      .then(({ body }) => {
        if (current) setShown({ of, body })
      })
      .catch((cause: unknown) => {
        if (current) {
          setShown({ of, failure: cause instanceof Error ? cause.message : String(cause) })
        }
      })
    return () => {
      current = false
    }
  }, [port, sessionId, tabId, of])

  // Nothing of another tab is ever shown under this one's title.
  const answer = shown?.of === of ? shown : undefined
  if (answer === undefined) return null
  // The tab stays open whatever a failure says: curation is the agent's.
  if (answer.failure !== undefined) return <p className="exhibit-failure">{answer.failure}</p>
  return (
    <div className="mdview">
      <Markdown markdown={answer.body ?? ''} />
    </div>
  )
}
