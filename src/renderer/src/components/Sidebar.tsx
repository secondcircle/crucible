import type { ShellSnapshot, SessionId, WorkspaceId } from '../../../shared/agent/port'
import { sessionLabel } from '../labels'
import './sidebar.css'

/**
 * The left sidebar: workspaces, and the curated sessions of the active one
 * (A16, mock A and mock F).
 *
 * Everything it shows comes from the snapshot, so there is no membership rule
 * in here at all: the sidebar contains what main says is curated, which is only
 * ever what a person created or explicitly resumed (ADR 0002). It shows working
 * state per session and per workspace, and both are the snapshot's `working`
 * flags rather than anything this component times or guesses (SE-5, WS-8).
 *
 * A row's working state is in its accessible name rather than in a colored dot
 * alone: the dot is the eye's version, the name is everybody else's.
 */
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

              {active ? (
                <ul className="sessions">
                  {own.map((session) => {
                    const label = sessionLabel(session)
                    return (
                      <li key={session.id} className="sessrow">
                        <button
                          className={`sess${session.id === activeSessionId ? ' active' : ''}`}
                          aria-current={session.id === activeSessionId ? 'true' : undefined}
                          aria-label={session.working ? `${label} (working)` : label}
                          onClick={() => onActivateSession(session.id)}
                        >
                          <span
                            className={`dot${session.working ? ' working' : ''}`}
                            aria-hidden="true"
                          />
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
                  <li>
                    <button className="more" onClick={onResume}>
                      Resume session…
                    </button>
                  </li>
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
