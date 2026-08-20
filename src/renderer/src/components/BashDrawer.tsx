import { useEffect, useRef } from 'react'
import type { RunId } from '../../../shared/workspace/service'
import './bash-drawer.css'

// The drawer a bash run lands in. It belongs to the workspace, not to a
// session: switching sessions inside the workspace leaves it where it was.

export interface RunView {
  /** Absent only in the moment between Run and the service answering. */
  readonly runId?: RunId
  readonly command: string
  readonly output: string
  readonly state: 'running' | 'ended' | 'stopped'
  /** Present only when the run genuinely exited. */
  readonly exitCode?: number
  /** A share is in flight: the model has not seen it yet. */
  readonly sharing: boolean
  /** What the drawer has to say about its own state, if anything. */
  readonly note?: string
}

export function BashDrawer({
  run,
  onStop,
  onShare,
  onClose
}: {
  readonly run: RunView
  readonly onStop: () => void
  readonly onShare: () => void
  readonly onClose: () => void
}): React.JSX.Element {
  const tail = useRef<HTMLPreElement>(null)
  const running = run.state === 'running'

  useEffect(() => {
    // A long run tails rather than grows, so it cannot push the composer off
    // the screen.
    const node = tail.current
    if (node !== null && running) node.scrollTop = node.scrollHeight
  }, [run.output, running])

  return (
    <div className="drawer" aria-label={`Bash run: ${run.command}`}>
      <div className="drawerhead">
        <span className="prompt" aria-hidden="true">
          !
        </span>
        <span className="dcmd">{run.command}</span>
        {running ? (
          <>
            <span className="spin" aria-hidden="true" />
            <button className="dstop" onClick={onStop}>
              Stop
            </button>
          </>
        ) : run.state === 'stopped' ? (
          <span className="exit stopped">stopped</span>
        ) : (
          <span className={`exit ${run.exitCode === 0 ? 'ok' : 'bad'}`}>exit {run.exitCode}</span>
        )}
      </div>

      <pre className="drawerout" ref={tail}>
        {run.output}
      </pre>

      <div className="drawerfoot">
        <button className="dadd" disabled={running || run.sharing} onClick={onShare}>
          Add to conversation
        </button>
        <span className="note">
          {run.sharing ? 'queued for the model…' : (run.note ?? 'stays local unless you add it')}
        </span>
        {/* Closing a running drawer is not offered: stop it first. */}
        {running ? null : (
          <button className="closeb" onClick={onClose}>
            Close ×
          </button>
        )}
      </div>
    </div>
  )
}
