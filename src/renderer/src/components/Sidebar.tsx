import type { ShellSnapshot, SessionId, WorkspaceId } from '../../../shared/agent/port'
import { sessionLabel } from '../labels'
import './sidebar.css'

// A row's working state is in its accessible name and not the colored dot
// alone: the dot is the eye's version, the name is everybody else's. A
// worktree session says so the same way, glyph and name together.
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
  onResume
}: {
  readonly snapshot: ShellSnapshot
  readonly onNewSession: () => void
  readonly onAddWorkspace: () => void
  readonly onActivateWorkspace: (id: WorkspaceId) => void
  readonly onRemoveWorkspace: (id: WorkspaceId) => void
  readonly onActivateSession: (id: SessionId) => void
  readonly onRemoveSession: (id: SessionId) => void
  readonly onResume: () => void
}): React.JSX.Element {
  const { workspaces, activeWorkspaceId, sessions, activeSessionId } = snapshot

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
                    const label = sessionLabel(session)
                    // Knowing *that* a session is in a worktree is the whole
                    // signal here; which worktree lives in the composer chip.
                    const marks = [
                      session.worktree === undefined ? undefined : 'worktree',
                      session.working ? 'working' : undefined
                    ].filter((mark): mark is string => mark !== undefined)
                    return (
                      <li key={session.id} className="sessrow">
                        <button
                          className={`sess${session.id === activeSessionId ? ' active' : ''}`}
                          aria-current={session.id === activeSessionId ? 'true' : undefined}
                          aria-label={marks.length === 0 ? label : `${label} (${marks.join(', ')})`}
                          onClick={() => onActivateSession(session.id)}
                        >
                          <span
                            className={`dot${session.working ? ' working' : ''}`}
                            aria-hidden="true"
                          />
                          {session.worktree === undefined ? null : (
                            <span className="wt" aria-hidden="true">
                              ⑂
                            </span>
                          )}
                          {label}
                        </button>
                        <button
                          className="rowaction"
                          aria-label={`Remove ${label}`}
                          title="Forget this session — the conversation can be resumed later"
                          onClick={() => onRemoveSession(session.id)}
                        >
                          ×
                        </button>
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

      <button className="addws" onClick={onAddWorkspace}>
        ＋ Add workspace
      </button>
    </nav>
  )
}
