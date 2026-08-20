import type { ModelInfo, SessionState, WorkspaceState } from '../../../shared/agent/port'
import { contextPercent, sessionLabel, tokens } from '../labels'
import './topbar.css'

// The meter shows a dash until the adapter reports real usage: a context meter
// that guesses is worse than one that admits it does not know yet.
export function TopBar({
  session,
  workspace,
  model,
  menuOpen,
  treeOpen,
  onToggleMenu,
  onToggleTree,
  onResetSession,
  onOpenSettings,
  onOpenUsage,
  update
}: {
  readonly session?: SessionState
  readonly workspace?: WorkspaceState
  readonly model?: ModelInfo
  readonly menuOpen: boolean
  readonly treeOpen: boolean
  readonly onToggleMenu: () => void
  readonly onToggleTree: () => void
  readonly onResetSession: () => void
  /** The gear: providers are global, so it is there with no session too. */
  readonly onOpenSettings: () => void
  /** The cost chip, which lands on the same sheet's Usage tab. */
  readonly onOpenUsage: () => void
  /** A newer installed build, waiting. One click restarts into it. */
  readonly update?: { readonly commit: string; readonly onRestart: () => void }
}): React.JSX.Element {
  const usage = session?.usage
  const percent = contextPercent(usage)
  const meter =
    usage === undefined || percent === undefined
      ? undefined
      : { percent, used: tokens(usage.usedTokens), window: tokens(usage.contextWindow) }

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

      {/* The mouse and dictation path into the tree; double-Esc is only an
          accelerator for it. */}
      {session === undefined ? null : (
        <button
          className={`treebtn${treeOpen ? ' active' : ''}`}
          aria-label="Session tree"
          aria-expanded={treeOpen}
          onClick={onToggleTree}
        >
          <span aria-hidden="true">⑂</span> Tree <span className="hint">esc esc</span>
        </button>
      )}

      {/* Everything from here is right-aligned, as mocked. */}
      <span className="spacer" />

      {/* Restarting mid-turn drops that turn, so the person decides when. */}
      {update === undefined ? null : (
        <button
          className="update"
          aria-label="Restart into the updated app"
          title={`A newer build (${update.commit}) is installed. Restart to pick it up.`}
          onClick={update.onRestart}
        >
          ↻ Update ready · Restart
        </button>
      )}

      {/* A dash until the adapter has reported real cost, exactly the meter's
          honesty rule. */}
      {session === undefined ? null : (
        <button className="cost" aria-label="Session cost" onClick={onOpenUsage}>
          {usage?.cost === undefined ? '—' : `$${usage.cost.toFixed(2)}`}
        </button>
      )}

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

      <button className="gear" aria-label="Settings" onClick={onOpenSettings}>
        <span aria-hidden="true">⚙</span>
      </button>

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
