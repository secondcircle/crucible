import { useEffect, useState } from 'react'
import type { SessionId, ShellSnapshot, WorkspaceId } from '../../../shared/agent/port'
// Titles are the model's now, so the row shows a title and a relative time;
// sessionLabel is gone.
import { relativeTime } from '../labels'
import type { QuotaView } from '../quota/use-quota'
import { QuotaStrip } from './QuotaStrip'
import './sidebar.css'

const UNTITLED = 'New session'

// Relative times go stale on their own, so the rows are re-rendered on a slow
// tick and "just now" cannot fossilize.
const TICK_MS = 30_000

// A row's working state is in its accessible name and not the colored dot
// alone: the dot is the eye's version, the name is everybody else's.
//
// Every workspace lists its sessions, active or not, because work in one
// workspace keeps running while another is in front. Only the human removes a
// session from the list. A workspace with no sessions still gets its row.
export function Sidebar({
  snapshot,
  onNewSession,
  onAddWorkspace,
  onActivateWorkspace,
  onRemoveWorkspace,
  onActivateSession,
  onRemoveSession,
  onResume,
  quota
}: {
  readonly snapshot: ShellSnapshot
  readonly onNewSession: () => void
  readonly onAddWorkspace: () => void
  readonly onActivateWorkspace: (id: WorkspaceId) => void
  readonly onRemoveWorkspace: (id: WorkspaceId) => void
  readonly onActivateSession: (id: SessionId) => void
  readonly onRemoveSession: (id: SessionId) => void
  readonly onResume: () => void
  // The quota strip's data. Absent without a quota service, and then no strip
  // renders at all.
  readonly quota?: QuotaView
}): React.JSX.Element {
  const { workspaces, activeWorkspaceId, sessions, activeSessionId } = snapshot
  const now = useClock()

  return (
    <nav className="side" aria-label="Workspaces and sessions">
      <div className="brand">
        <span className="mark" aria-hidden="true">
          ◆
        </span>{' '}
        CRUCIBLE
      </div>

      <button className="newsession" onClick={onNewSession} disabled={activeWorkspaceId === undefined}>
        New session
      </button>

      <div className="wslabel">Workspaces</div>

      <ul className="wslist">
        {workspaces.map((workspace) => {
          const own = sessions.filter((session) => session.workspaceId === workspace.id)
          const active = workspace.id === activeWorkspaceId
          const working = own.some((session) => session.working)

          return (
            <li key={workspace.id}>
              <div className={`ws${active ? ' active' : ''}${working ? ' working' : ''}`}>
                <button
                  className="wsname"
                  aria-current={active ? 'true' : undefined}
                  aria-label={working ? `${workspace.name} (working)` : workspace.name}
                  onClick={() => onActivateWorkspace(workspace.id)}
                >
                  <span className="dot" aria-hidden="true" />
                  {workspace.name}
                </button>
                <button
                  className="rowaction"
                  aria-label={`Remove workspace ${workspace.name}`}
                  title="Remove from Crucible — the folder is not touched"
                  onClick={() => onRemoveWorkspace(workspace.id)}
                >
                  ×
                </button>
              </div>

              {own.length > 0 || active ? (
                <ul className="sessions">
                  {own.map((session) => {
                    const title = session.title ?? UNTITLED
                    return (
                      <li key={session.id} className="sessrow">
                        <button
                          className={rowClass(session.id === activeSessionId, session.title)}
                          aria-current={session.id === activeSessionId ? 'true' : undefined}
                          aria-label={session.working ? `${title} (working)` : title}
                          // Always set, so a title the two-line clamp cut off
                          // is readable in full without leaving the sidebar.
                          title={title}
                          onClick={() => onActivateSession(session.id)}
                        >
                          {/* The clamp lives on this span, not the button:
                              overflow clips at the padding edge, so a padded
                              clamp box leaks the top of the cut-off line. */}
                          <span className="sesstext">
                            <span
                              className={`dot${session.working ? ' working' : ''}`}
                              aria-hidden="true"
                            />
                            {title}
                          </span>
                        </button>
                        {/* The time and the remove button share one slot on
                            the right: the time is the resting state, the ×
                            takes its place on hover, and neither moves the
                            title. A two-line title keeps its time. */}
                        <span className="rowend">
                          <small aria-hidden="true">
                            {relativeTime(session.lastActivityAt ?? session.createdAt, now)}
                          </small>
                          <button
                            className="rowaction"
                            aria-label={`Remove ${title}`}
                            title="Forget this session — the conversation can be resumed later"
                            onClick={() => onRemoveSession(session.id)}
                          >
                            ×
                          </button>
                        </span>
                      </li>
                    )
                  })}
                  {active ? (
                    <li>
                      <button className="more" onClick={onResume}>
                        Resume session…
                      </button>
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </li>
          )
        })}
      </ul>

      {/* Pinned at the foot: the workspace list above scrolls, this and Add
          workspace stay put. */}
      {quota === undefined ? null : <QuotaStrip snapshot={quota.snapshot} now={quota.now} />}

      <button className="addws" onClick={onAddWorkspace}>
        ＋ Add workspace
      </button>
    </nav>
  )
}

function rowClass(active: boolean, title?: string): string {
  return `sess${active ? ' active' : ''}${title === undefined ? ' untitled' : ''}`
}

// The clock the relative times are read against, so they age on their own
// rather than only when something else re-renders the sidebar.
function useClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(tick)
  }, [])
  return now
}
