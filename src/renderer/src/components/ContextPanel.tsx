import { useEffect, useRef, useState } from 'react'
import { exhibitUrl } from '../../../shared/agent/exhibit-url'
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

  useEffect(() => () => endDrag.current?.(), [])

  function startDrag(): void {
    if (endDrag.current !== undefined) return

    function onMove(moved: MouseEvent): void {
      const room = window.innerWidth - MIN_CHAT
      onResize(Math.max(MIN_PANEL, Math.min(window.innerWidth - moved.clientX, room)))
    }

    function onUp(): void {
      endDrag.current = undefined
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
              <span className="kind">{tab.kind === 'html' ? 'html' : 'md'}</span>
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

        <Exhibit sessionId={sessionId} tab={active} port={port} />
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

// What is on display. Either way the renderer knows a tab by its id and by
// nothing else: a markdown body comes back through the port, and an HTML
// exhibit is loaded by the frame itself from the exhibit scheme, which resolves
// that same id against the panel model.
function Exhibit({
  sessionId,
  tab,
  port
}: {
  readonly sessionId: SessionId
  readonly tab: PanelState['tabs'][number] | undefined
  readonly port: AgentPort
}): React.JSX.Element {
  return (
    <div className="exhibit">
      {tab === undefined ? null : tab.kind === 'html' ? (
        // Browser-page rules: the exhibit's own scripts run, under the policy
        // its own response header carries, and nothing else is granted. No
        // same-origin, no preload, no Node, no IPC, no reach into the app.
        // The key is the tab's identity including its latest show, so a re-show
        // remounts the frame and `no-store` makes the reload fetch the bytes
        // that are on disk now.
        <iframe
          key={`${sessionId}:${tab.id}:${tab.shownAt}`}
          className="frame"
          sandbox="allow-scripts"
          title={tab.title}
          src={exhibitUrl(sessionId, tab.id)}
        />
      ) : (
        <MarkdownExhibit sessionId={sessionId} tab={tab} port={port} />
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
