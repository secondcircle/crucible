import type { LiveMonitor } from '../../../shared/monitors/monitor'
import { briefDuration } from '../../../shared/monitors/wording'
import { inlineOutput, waitedFor } from '../monitors/activity'
import './monitors.css'

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
        <b title={monitor.description}>{monitor.description}</b>
        {last === undefined ? null : <span className="last">{last}</span>}
        <span className="left">
          {waited} · every {briefDuration(monitor.intervalMs)} · up to{' '}
          {briefDuration(monitor.timeoutMs)}
        </span>
      </button>
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
