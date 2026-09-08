import type { SessionId, ShellSnapshot, WorkspaceId } from '../../../shared/agent/port'
import { useClock } from '../clock'
import { hairline, idleWorkspaces, rows, type SidebarModel } from '../sidebar/model'
import type { Folding } from '../sidebar/use-folded'
import { waitedFor, type MonitorActivity } from '../monitors/activity'
// Titles are the model's now, so the row shows a title and a relative time;
// sessionLabel is gone.
import { elapsedTime, relativeTime, UNTITLED } from '../labels'
import type { RunActivity } from '../runs/activity'
import { shortAge } from '../runs/format'
import type { Marks } from '../state/needs-you'
import type { AppVersionState } from '../../../shared/app-update/service'
import type { CacheHealth } from '../../../shared/cache/service'
import type { QuotaView } from '../quota/use-quota'
import { CacheStrip } from './CacheStrip'
import { QuotaStrip } from './QuotaStrip'
import { VersionStrip } from './VersionStrip'
import './sidebar.css'

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
// A run working in a session's name gets the same block in the run color: the
// run's age over dots that blink while it runs and hold still while it is
// paused. Green and teal are two different waits — one you watch, the other
// you come back to.
//
// Every workspace lists its sessions, active or not, because work in one
// workspace keeps running while another is in front. Only the human removes a
// session from the list. A workspace with no sessions still gets its row.
//
// A folded workspace shows its own row and nothing else: the dot, the two
// counts and, in the times' faint mono, how many session rows the fold hid.
// Which rows are folded is the Shell's state, and so is their order — this
// component renders what it is handed and decides neither.
export function Sidebar({
  snapshot,
  model,
  folding,
  needsYou,
  runActivity,
  waiting: waitActivity,
  boardNeedYou,
  onNewSession,
  onAddWorkspace,
  onActivateWorkspace,
  onRemoveWorkspace,
  onActivateSession,
  onRemoveSession,
  onResume,
  onOpenSettings,
  settingsOpen,
  cache,
  quota,
  version
}: {
  readonly snapshot: ShellSnapshot
  // The order, the dots and what is in use, all decided above. The workspace
  // rows come from `model.ordered` and never from `snapshot.workspaces`:
  // `snapshot` is read for sessions and for the two active ids.
  readonly model: SidebarModel
  // The folded set and the only three verbs that change it. There is no verb
  // for folding on activity or unfolding on idleness, which is why neither
  // can happen.
  readonly folding: Folding
  // Sessions whose turn ended while nobody was looking. In-memory only, and
  // the document above decides what goes in and what comes out.
  readonly needsYou: Marks
  // Sessions with a live run of their own, derived from the runs snapshot by
  // the shell. Absent for a session with none.
  readonly runActivity: Readonly<Record<SessionId, RunActivity>>
  readonly waiting?: Readonly<Record<SessionId, MonitorActivity>>
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
  /** The gear at the foot: the only place Settings is reachable by mouse. */
  readonly onOpenSettings: () => void
  /** Lit while Settings occupies the overlay region. */
  readonly settingsOpen: boolean
  // The cache strip's data and its one action. Absent without a cache
  // service, and then no strip renders at all.
  readonly cache?: { readonly health?: CacheHealth; readonly onOpen: () => void }
  // The quota strip's data. Absent without a quota service, and then no strip
  // renders at all.
  readonly quota?: QuotaView
  // The version strip's snapshot and its two actions. Absent without a
  // version service, and then no strip renders at all.
  readonly version?: {
    readonly state: AppVersionState
    readonly checking: boolean
    readonly onRestart: () => void
    readonly onCheck: () => void
  }
}): React.JSX.Element {
  const { activeWorkspaceId, sessions, activeSessionId } = snapshot
  const now = useClock(
    sessions.some((session) => session.working) ||
      Object.keys(waitActivity ?? {}).length > 0
  )
  const workspaces = rows(model.ordered)
  // The line between the bands is drawn on the first row below it, so there is
  // no list item where it sits for a screen reader to announce.
  const bandStartId = hairline(model.ordered) ? model.ordered.older[0]?.id : undefined
  // Recomputed every render from the live folded set, so "nothing left to fold"
  // is one fact read here and by the click below rather than a mode to keep.
  const idle = idleWorkspaces(workspaces, folding.folded, model.inUse)

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

      {/* The label and the one list-wide action share a row, and the action
          wears the label's own voice: it is furniture, not a feature. */}
      <div className="wshead">
        <div className="wslabel">Workspaces</div>
        {/* aria-disabled rather than disabled: the click that folds the last
            foldable workspace disables this control, and a browser drops focus
            to the body when a focused element becomes disabled. */}
        <button
          className="collapseidle"
          aria-disabled={idle.length === 0}
          title="Collapse every workspace with nothing working, waiting on you, or in front of you"
          onClick={() => {
            if (idle.length === 0) return
            folding.foldAll(idle)
          }}
        >
          Collapse idle
        </button>
      </div>

      <ul className="wslist">
        {workspaces.map((workspace) => {
          const own = sessions.filter((session) => session.workspaceId === workspace.id)
          const active = workspace.id === activeWorkspaceId
          // The dot is the coarse mark, "something in here is working", so a
          // live run lights it exactly as a live turn does. Read from the model
          // rather than computed here, so the dot and what Collapse idle spares
          // are the same set.
          const working = model.working.has(workspace.id)
          const folded = folding.folded.has(workspace.id)
          // The roll-up, so a folded or scrolled-past workspace still says
          // how many of its sessions are waiting.
          const asking = own.filter((session) => needsYou.has(session.id)).length
          const board = boardNeedYou[workspace.id] ?? 0

          return (
            <li key={workspace.id}>
              <div
                className={`ws${active ? ' active' : ''}${working ? ' working' : ''}${
                  folded ? ' folded' : ''
                }${workspace.id === bandStartId ? ' bandstart' : ''}`}
              >
                {/* In the row's left padding, where a tree puts it, so the
                    names keep the left edge they have always had. */}
                <button
                  className="chev"
                  aria-expanded={!folded}
                  aria-label={`${folded ? 'Expand' : 'Collapse'} ${workspace.name}`}
                  onClick={() => folding.toggle(workspace.id)}
                >
                  <span aria-hidden="true">▼</span>
                </button>
                <button
                  className="wsname"
                  aria-current={active ? 'true' : undefined}
                  aria-label={working ? `${workspace.name} (working)` : workspace.name}
                  onClick={() => {
                    onActivateWorkspace(workspace.id)
                    // Going to a folded workspace opens it: arriving somewhere
                    // means seeing what is there.
                    folding.unfold(workspace.id)
                  }}
                >
                  <span className="dot" aria-hidden="true" />
                  {workspace.name}
                </button>
                {/* What the fold hid, in the faint mono the row times use. A
                    count of rows rather than of anything needing you, so it
                    wears no pill. */}
                {folded && own.length > 0 ? (
                  <span
                    className="wsc"
                    title={`${own.length} ${own.length === 1 ? 'session' : 'sessions'} folded in ${workspace.name}`}
                  >
                    {own.length}
                  </span>
                ) : null}
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

              {!folded && (own.length > 0 || active) ? (
                <ul className="sessions">
                  {own.map((session) => {
                    const title = session.title ?? UNTITLED
                    const viewing = session.id === activeSessionId
                    const asks = needsYou.has(session.id)
                    const activity = runActivity[session.id]
                    const waits = waitActivity?.[session.id]
                    const turnSince = session.working ? session.workingSince : undefined
                    const runSlot = asks || turnSince !== undefined ? undefined : activity
                    const waitSlot =
                      asks || turnSince !== undefined || runSlot !== undefined ? undefined : waits
                    // Knowing *that* a session is in a worktree is the whole
                    // signal here; which worktree lives in the composer chip.
                    // A run working is named even when it lost the slot: the
                    // name is the whole row for anyone not reading the dots.
                    const marks = [
                      session.worktree === undefined ? undefined : 'worktree',
                      session.working ? 'working' : undefined,
                      activity === undefined ? undefined : 'run working',
                      waits === undefined ? undefined : 'waiting',
                      asks ? 'needs you' : undefined
                    ].filter((mark): mark is string => mark !== undefined)
                    return (
                      <li
                        key={session.id}
                        className={`sessrow${viewing ? ' viewing' : ''}${asks ? ' asking' : ''}${
                          runSlot === undefined ? '' : runSlot.moving ? ' run' : ' run held'
                        }`}
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
                          {turnSince !== undefined ? (
                            <>
                              <span className="elapsed" aria-hidden="true">
                                {elapsedTime(turnSince, now)}
                              </span>
                              {/* Three dots, blinking in sequence: the only
                                  animation a row is allowed. */}
                              <span className="typing" aria-hidden="true">
                                <i />
                                <i />
                                <i />
                              </span>
                            </>
                          ) : runSlot !== undefined ? (
                            <>
                              {/* The run's age in the chips' own units, from
                                  the chips' own function: the rail and the
                                  chip cannot report one run two ways. */}
                              <span className="elapsed" aria-hidden="true">
                                {shortAge(runSlot.since, now)}
                              </span>
                              <span className="typing" aria-hidden="true">
                                <i />
                                <i />
                                <i />
                              </span>
                            </>
                          ) : waitSlot !== undefined ? (
                            <span className="waiting" aria-hidden="true">
                              ⏳ {waitedFor(waitSlot.since, now)}
                            </span>
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
      {/* The foot order is fixed: cache, quota, version, then Add workspace
          and the gear. */}
      {version === undefined ? null : (
        <VersionStrip
          state={version.state}
          checking={version.checking}
          onRestart={version.onRestart}
          onCheck={version.onCheck}
        />
      )}

      <div className="sidefoot">
        <button className="addws" onClick={onAddWorkspace}>
          ＋ Add workspace
        </button>
        <button
          className={`gearbtn${settingsOpen ? ' on' : ''}`}
          aria-label="Settings"
          aria-pressed={settingsOpen}
          onClick={onOpenSettings}
        >
          <span aria-hidden="true">⚙</span>
        </button>
      </div>
    </nav>
  )
}

function rowClass(active: boolean, title?: string): string {
  return `sess${active ? ' active' : ''}${title === undefined ? ' untitled' : ''}`
}
