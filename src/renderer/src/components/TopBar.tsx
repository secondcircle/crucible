import type { SessionState } from '../../../shared/agent/port'
import { missesText } from '../cache/format'
import { contextPercent, tokens } from '../labels'
import './cache-strip.css'
import './topbar.css'

// Nothing here repeats a fact the sidebar rows or the composer chip already
// state, which is why the session, workspace and model are absent.
//
// The meter shows a dash until the adapter reports real usage: a context meter
// that guesses is worse than one that admits it does not know yet.
export function TopBar({
  session,
  menuOpen,
  treeOpen,
  onToggleMenu,
  onToggleTree,
  onResetSession,
  onOpenSettings,
  onOpenUsage,
  onJumpToCacheMiss,
  issues,
  board,
  update
}: {
  readonly session?: SessionState
  readonly menuOpen: boolean
  readonly treeOpen: boolean
  readonly onToggleMenu: () => void
  readonly onToggleTree: () => void
  readonly onResetSession: () => void
  /** The gear: providers are global, so it is there with no session too. */
  readonly onOpenSettings: () => void
  /** The cost chip, which lands on the same sheet's Usage tab. */
  readonly onOpenUsage: () => void
  /** The cache badge: scroll the transcript to the most recent seam. */
  readonly onJumpToCacheMiss: () => void
  // The issue board's whole resting surface, on the same terms: absent until a
  // collection has answered with a board for this workspace.
  readonly issues?: {
    readonly open: number
    readonly yours: number
    readonly onOpen: () => void
  }
  // The branch board's whole resting surface: absent until a collection has
  // answered with a board for this workspace.
  readonly board?: {
    readonly landed: number
    readonly needYou: number
    readonly onOpen: () => void
  }
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

      {/* Lit exactly while an issue is assigned to you: unclaimed ones are
          everybody's, and counting them would light the chip forever. */}
      {issues === undefined ? null : (
        <button
          className={`tchip${issues.yours > 0 ? ' lit' : ''}`}
          aria-label="Issue board"
          onClick={issues.onOpen}
        >
          <span className="g" aria-hidden="true">
            ◎
          </span>{' '}
          <b>
            {issues.open} issue{issues.open === 1 ? '' : 's'}
          </b>
          {issues.yours > 0 ? <u> · {issues.yours} yours</u> : null}
        </button>
      )}

      {/* Lit exactly while something needs you, so it is not permanently on. */}
      {board === undefined ? null : (
        <button
          className={`tchip${board.needYou > 0 ? ' lit' : ''}`}
          aria-label="Branch board"
          onClick={board.onOpen}
        >
          <span className="g" aria-hidden="true">
            ⑂
          </span>{' '}
          <b>{board.landed} landed</b>
          {board.needYou > 0 ? <u> · {board.needYou} need you</u> : null}
        </button>
      )}

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

      {/* This session's whole-conversation misses, absent at zero. Amber and
          never red: red in this app means failure, and a cache miss is money.
          Clicking it lands on the most recent seam. */}
      {session?.cacheMisses === undefined || session.cacheMisses.count === 0 ? null : (
        <button
          className="cost cachebadge"
          aria-label={`${session.cacheMisses.count} cache ${
            session.cacheMisses.count === 1 ? 'miss' : 'misses'
          } in this session`}
          onClick={onJumpToCacheMiss}
        >
          <span aria-hidden="true">⚠</span> {missesText(session.cacheMisses.count)}
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
