import type { ModelInfo, SessionState, WorkspaceState } from '../../../shared/agent/port'
import { sessionLabel, tokens } from '../labels'
import './topbar.css'

// The meter shows a dash until the adapter reports real usage: a context meter
// that guesses is worse than one that admits it does not know yet.
export function TopBar({
  session,
  workspace,
  model,
  menuOpen,
  onToggleMenu,
  onResetSession
}: {
  readonly session?: SessionState
  readonly workspace?: WorkspaceState
  readonly model?: ModelInfo
  readonly menuOpen: boolean
  readonly onToggleMenu: () => void
  readonly onResetSession: () => void
}): React.JSX.Element {
  const usage = session?.usage
  const meter =
    usage === undefined || usage.contextWindow <= 0
      ? undefined
      : {
          percent: Math.min(100, Math.round((usage.usedTokens / usage.contextWindow) * 100)),
          used: tokens(usage.usedTokens),
          window: tokens(usage.contextWindow)
        }

  return (
    <header className="top">
      <span className="title">{session === undefined ? 'No session' : sessionLabel(session)}</span>
      <span className="where">{workspace?.name ?? 'No workspace'}</span>
      {session?.model === undefined ? null : (
        <span className="model">{model?.label ?? session.model}</span>
      )}
      {session?.working ? (
        <span className="working" aria-label="Agent working">
          ● working
        </span>
      ) : null}

      <div className="meter" aria-label="Context usage">
        {meter === undefined ? (
          <span className="empty">— ctx</span>
        ) : (
          <>
            <span>{meter.percent}% ctx</span>
            <span className="bar">
              <i style={{ width: `${meter.percent}%` }} />
            </span>
            <span className="counts">
              {meter.used} / {meter.window}
            </span>
          </>
        )}
      </div>

      {session === undefined ? null : (
        <div className="sessionmenu">
          <button aria-label="Session menu" aria-expanded={menuOpen} onClick={onToggleMenu}>
            ⋯
          </button>
          {menuOpen ? (
            <div className="menu" role="menu">
              <button role="menuitem" onClick={onResetSession}>
                Reset session
              </button>
            </div>
          ) : null}
        </div>
      )}
    </header>
  )
}
