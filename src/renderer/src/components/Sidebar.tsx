import { useEffect, useState } from 'react'
import type { SessionId, ShellSnapshot, WorkspaceId } from '../../../shared/agent/port'
// Titles are the model's now, so the row shows a title and a relative time;
// sessionLabel is gone.
import { elapsedTime, relativeTime } from '../labels'
import type { QuotaView } from '../quota/use-quota'
import { QuotaStrip } from './QuotaStrip'
import './sidebar.css'

const UNTITLED = 'New session'

// Relative times go stale on their own, so the rows are re-rendered on a slow
// tick and "just now" cannot fossilize.
const TICK_MS = 30_000

// A counter that only moved every 30s would look stopped, so the whole rail
// ticks per second for as long as anything is working, and drops back after.
const WORKING_TICK_MS = 1_000

// Two states, two channels, so a rail full of running agents still says which
// session you are in. Viewing is the slab: a filled row with an accent edge,
// which holds still. Working is the right-hand block: a counter of how long
// the turn has run, with three blinking dots under it, and it is the only
// thing in the row that moves. Nothing in the title column carries state, so
// every title starts on the same left edge.
//
// A row's working state is in its accessible name and not the moving dots
// alone: the dots are the eye's version, the name is everybody else's. A
// worktree session says so the same way, glyph and name together.
//
// Every workspace lists its sessions, active or not, because work in one
// workspace keeps running while another is in front. Only the human removes a
// session from the list. A workspace with no sessions still gets its row.
export function Sidebar({
  snapshot,
  needYou,
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
  // The whole cross-workspace glance: one number per workspace, and nothing
  // for a workspace whose board has not answered or has nothing asking.
  readonly needYou: Readonly<Record<WorkspaceId, number>>
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
  const now = useClock(sessions.some((session) => session.working))

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
                {(needYou[workspace.id] ?? 0) > 0 ? (
                  <span
                    className="n"
                    title={`${needYou[workspace.id]} need you in ${workspace.name}`}
                  >
                    {needYou[workspace.id]}
                  </span>
                ) : null}
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
                    const viewing = session.id === activeSessionId
                    // Knowing *that* a session is in a worktree is the whole
                    // signal here; which worktree lives in the composer chip.
                    const marks = [
                      session.worktree === undefined ? undefined : 'worktree',
                      session.working ? 'working' : undefined
                    ].filter((mark): mark is string => mark !== undefined)
                    return (
                      <li key={session.id} className={`sessrow${viewing ? ' viewing' : ''}`}>
                        <button
                          className={rowClass(viewing, session.title)}
                          aria-current={viewing ? 'true' : undefined}
                          aria-label={marks.length === 0 ? title : `${title} (${marks.join(', ')})`}
                          // Always set, so a title the two-line clamp cut off
                          // is readable in full without leaving the sidebar.
                          title={title}
                          onClick={() => onActivateSession(session.id)}
                        >
                          {/* The clamp lives on this span, not the button:
                              overflow clips at the padding edge, so a padded
                              clamp box leaks the top of the cut-off line. */}
                          <span className="sesstext">
                            {session.worktree === undefined ? null : (
                              <span className="wt" aria-hidden="true">
                                ⑂
                              </span>
                            )}
                            {title}
                          </span>
                        </button>
                        {/* One slot on the right, centered against the whole
                            title block: how long ago at rest, how long so far
                            plus the dots while working, and the × over both on
                            hover. Nothing here ever moves the title. */}
                        <span className="rowend">
                          {session.working && session.workingSince !== undefined ? (
                            <>
                              <span className="elapsed" aria-hidden="true">
                                {elapsedTime(session.workingSince, now)}
                              </span>
                              {/* Three dots, blinking in sequence: the only
                                  animation a row is allowed. */}
                              <span className="typing" aria-hidden="true">
                                <i />
                                <i />
                                <i />
                              </span>
                            </>
                          ) : (
                            <small aria-hidden="true">
                              {relativeTime(session.lastActivityAt ?? session.createdAt, now)}
                            </small>
                          )}
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

// The clock the times are read against, so they age on their own rather than
// only when something else re-renders the sidebar. One clock for both kinds:
// a running counter needs a second, a "4m ago" does not, and paying for the
// fast one only while something works keeps an idle rail still.
function useClock(working: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const every = working ? WORKING_TICK_MS : TICK_MS
    const tick = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(tick)
  }, [working])
  return now
}
