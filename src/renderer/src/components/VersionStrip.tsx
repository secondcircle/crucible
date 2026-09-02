import type { AppVersionState } from '../../../shared/app-update/service'
import { agoLabel } from '../labels'
import './version-strip.css'

// One block for the whole app at the foot of the rail, below the quota strip
// and above Add workspace, in the cache strip's grammar: the rail's gutter, an
// 11.5px label line, a mono second line. What is running, whether it is
// current, and — when a newer version is already on disk — the second door to
// the restart the top bar pill offers. Two doors, one act.
//
// It says nothing it cannot support: before the first check has answered the
// right slot is empty rather than claiming "up to date", and a dev launch
// says plainly that nothing is being checked.

export function VersionStrip({
  state,
  now,
  onRestart
}: {
  readonly state: AppVersionState
  /** The sidebar's own clock, so `checked 4 min ago` ages without a reload. */
  readonly now: number
  readonly onRestart: () => void
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
      <span className="vwhen">{secondLine(state, now)}</span>
    </div>
  )
}

function secondLine(state: AppVersionState, now: number): string {
  if (state.kind === 'dev') return 'updates are not checked in dev'
  if (state.update.kind === 'current') return `checked ${agoLabel(state.update.checkedAt, now)}`
  // Nothing has answered yet, and an app that has not looked must not say it
  // is up to date.
  return 'checking for updates…'
}
