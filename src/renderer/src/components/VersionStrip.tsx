import type { AppVersionState } from '../../../shared/app-update/service'
import './version-strip.css'

// The rail-foot block: what is running, whether it is current, and — when a
// newer version is already on disk — the second door to the restart the top
// bar pill offers. It says nothing it cannot support: before the first check
// has answered the right slot stays empty rather than claiming "up to date",
// and a dev launch says plainly that nothing is being checked. While the app
// is current the second line is the one thing to do here: ask now, rather
// than wait for the next poll.

export function VersionStrip({
  state,
  checking,
  onRestart,
  onCheck
}: {
  readonly state: AppVersionState
  /** A check the human asked for is still running. */
  readonly checking: boolean
  readonly onRestart: () => void
  readonly onCheck: () => void
}): React.JSX.Element {
  if (state.kind === 'installed' && state.update.kind === 'ready') {
    const waiting = state.update.version
    return (
      <button
        className="version ready"
        aria-label={`Restart into Crucible ${waiting}`}
        title={`${waiting} is installed. Restart to pick it up.`}
        // The teardown is the feedback: the restart goes out in this frame,
        // with no intermediate state to render.
        onClick={onRestart}
      >
        <span className="vline">
          <span>
            Crucible <b>{state.version}</b>
          </span>
          <span className="vpill">↻ {waiting} · Restart</span>
        </span>
        <span className="vwhen">downloaded, waiting for a restart</span>
      </button>
    )
  }

  return (
    <div className="version">
      <div className="vline">
        <span>
          Crucible <b>{state.version}</b>
        </span>
        {state.kind === 'dev' ? (
          <span className="vdev">
            {state.commit === undefined ? 'dev' : `dev · ${state.commit}`}
          </span>
        ) : state.update.kind === 'current' ? (
          <span className="vwhen">up to date</span>
        ) : null}
      </div>
      {state.kind === 'dev' ? (
        <span className="vwhen">updates are not checked in dev</span>
      ) : checking || state.update.kind === 'unchecked' ? (
        // Main's launch check, or the one just asked for: either way one is
        // running, and asking again would only join it.
        <span className="vwhen">checking for updates…</span>
      ) : (
        <button className="vcheck" onClick={onCheck}>
          check for updates
        </button>
      )}
    </div>
  )
}
