import type { LiveMonitor } from '../../../shared/monitors/monitor'
import { briefDuration } from '../../../shared/monitors/wording'
import { inlineOutput, waitedFor } from '../monitors/activity'
import './monitors.css'

// One live monitor in the strip: a breathing dot in the monitor color, the
// agent's description verbatim as the headline, the last thing the check
// printed, the timing, and a ✕ that stops it with no confirmation. The chip
// reads as a sentence — what is awaited, what it last said, how long it has
// waited, how often it checks, when it gives up.
export function MonitorChip({
  monitor,
  now,
  open,
  onOpen,
  onStop
}: {
  readonly monitor: LiveMonitor
  readonly now: number
  readonly open: boolean
  readonly onOpen: () => void
  readonly onStop: () => void
}): React.JSX.Element {
  const waited = waitedFor(monitor.setAt, now)
  const last = inlineOutput(monitor)

  return (
    <span className={`monchip${open ? ' open' : ''}`}>
      <button
        className="monopen"
        aria-expanded={open}
        aria-label={`Waiting on ${monitor.description}`}
        onClick={onOpen}
      >
        <span className="dot" aria-hidden="true" />
        {/* Verbatim, and never re-titled: what is cut off visually stays
            readable on hover. */}
        <b title={monitor.description}>{monitor.description}</b>
        {last === undefined ? null : <span className="last">{last}</span>}
        <span className="left">
          {waited} · every {briefDuration(monitor.intervalMs)} · up to{' '}
          {briefDuration(monitor.timeoutMs)}
        </span>
      </button>
      {/* Its own button, outside the one that opens: stopping is not a way of
          looking at something. */}
      <button
        className="x"
        aria-label={`Stop watching ${monitor.description}`}
        title="Stop watching"
        onClick={onStop}
      >
        ✕
      </button>
    </span>
  )
}
