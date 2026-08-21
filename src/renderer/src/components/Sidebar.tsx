import { useEffect, useState } from 'react'
import type { SessionId, ShellSnapshot, WorkspaceId } from '../../../shared/agent/port'
// Titles are the model's now, so the row shows a title and a relative time;
// sessionLabel is gone.
import { elapsedTime, relativeTime, UNTITLED } from '../labels'
import type { Marks } from '../state/needs-you'
import type { CacheHealth } from '../../../shared/cache/service'
import type { QuotaView } from '../quota/use-quota'
import { CacheStrip } from './CacheStrip'
import { QuotaStrip } from './QuotaStrip'
import './sidebar.css'

// Relative times go stale on their own, so the rows are re-rendered on a slow
// tick and "just now" cannot fossilize.
const TICK_MS = 30_000

// A counter that only moved every 30s would look stopped, so the whole rail
// ticks per second for as long as anything is working, and drops back after.
const WORKING_TICK_MS = 1_000

// Three states, three channels, so a rail full of running agents still says
// which session you are in. Viewing is the slab: a filled row with an accent
// edge, which holds still. Working is the right-hand block: a counter of how
// long the turn has run, with three blinking dots under it, and it is the only
// thing in the row that moves. Needs you is the third: an amber pip in that
// same block, the title lifted out of dim into full ink, and the time in
// amber. It is neither motion nor a slab, because those two channels are
// spoken for. Nothing in the title column carries state, so every title starts
// on the same left edge.
//
// A row's working state is in its accessible name and not the moving dots
// alone: the dots are the eye's version, the name is everybody else's. Needing
// you and being in a worktree say so the same way, mark and name together.
//
// Every workspace lists its sessions, active or not, because work in one
// workspace keeps running while another is in front. Only the human removes a
// session from the list. A workspace with no sessions still gets its row.
export function Sidebar({
  snapshot,
  needsYou,
  boardNeedYou,
  onNewSession,
  onAddWorkspace,
  onActivateWorkspace,
  onRemoveWorkspace,
  onActivateSession,
  onRemoveSession,
  onResume,
  cache,
  quota
}: {
  readonly snapshot: ShellSnapshot
  // Sessions whose turn ended while nobody was looking. In-memory only, and
  // the document above decides what goes in and what comes out.
  readonly needsYou: Marks
  // A different count on the same row: the board's branches and pull requests,
  // and nothing for a workspace whose board has not answered.
  readonly boardNeedYou: Readonly<Record<WorkspaceId, number>>
  readonly onNewSession: () => void
  readonly onAddWorkspace: () => void
  readonly onActivateWorkspace: (id: WorkspaceId) => void
  readonly onRemoveWorkspace: (id: WorkspaceId) => void
  readonly onActivateSession: (id: SessionId) => void
  readonly onRemoveSession: (id: SessionId) => void
  readonly onResume: () => void
  // The cache strip's data and its one action. Absent without a cache
  // service, and then no strip renders at all.
  readonly cache?: { readonly health?: CacheHealth; readonly onOpen: () => void }
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
          // The roll-up, so a collapsed or scrolled-past workspace still says
          // how many of its sessions are waiting.
          const asking = own.filter((session) => needsYou.has(session.id)).length
          const board = boardNeedYou[workspace.id] ?? 0

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
                {/* Sessions first and filled; the board's count after it and
                    outlined. Two counts of two different things, told apart
                    by weight rather than by position alone. */}
                {asking > 0 ? (
                  <span
                    className="wsn"
                    title={`${asking} ${asking === 1 ? 'session' : 'sessions'} waiting on you in ${workspace.name}`}
                  >
                    {asking}
                  </span>
                ) : null}
                {board > 0 ? (
                  <span className="n" title={`${board} need you in ${workspace.name}`}>
                    {board}
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
                    const asks = needsYou.has(session.id)
                    // Knowing *that* a session is in a worktree is the whole
                    // signal here; which worktree lives in the composer chip.
                    const marks = [
                      session.worktree === undefined ? undefined : 'worktree',
                      session.working ? 'working' : undefined,
                      asks ? 'needs you' : undefined
                    ].filter((mark): mark is string => mark !== undefined)
                    return (
                      <li
                        key={session.id}
                        className={`sessrow${viewing ? ' viewing' : ''}${asks ? ' asking' : ''}`}
                      >
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
                          {/* Static: the pip sits where the dots sit while
                              working, because the eye already looks there. */}
                          {asks ? <span className="pip" aria-hidden="true" /> : null}
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

      {/* Pinned at the foot: the workspace list above scrolls, these and Add
          workspace stay put. The cache strip sits above the quota block, as
          its own component rather than a quota row: one of them is clickable
          and the other never is. */}
      {cache === undefined ? null : <CacheStrip health={cache.health} onOpen={cache.onOpen} />}
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
