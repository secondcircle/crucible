import { useEffect, useRef } from 'react'
import type { LiveMonitor } from '../../../shared/monitors/monitor'
import {
  briefDuration,
  elapsedOfTimeout,
  longDuration
} from '../../../shared/monitors/wording'
import { elapsedFraction } from '../monitors/activity'
import './monitors.css'

// What a chip opens: the agent's reason in its own words, the cadence, how
// long since the last check, how many checks so far, the ending rule in words,
// where the checks run, the exact command, the retained output, a hairline of
// elapsed against the timeout, and Stop. Nothing here is editable: to change a
// wait, the agent stops it and sets another.
export function MonitorDetail({
  monitor,
  now,
  where,
  onClose,
  onStop
}: {
  readonly monitor: LiveMonitor
  readonly now: number
  /** "checkout" or "worktree": whether the monitor's directory is the session's own. */
  readonly where: 'checkout' | 'worktree'
  readonly onClose: () => void
  readonly onStop: () => void
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)

  // Escape and a click outside close it, exactly as they close any popover.
  // Closing is not stopping: nothing about the monitor changes either way.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose()
    }
    function onDown(event: MouseEvent): void {
      const target = event.target as HTMLElement | null
      if (target === null) return
      if (box.current?.contains(target) === true) return
      if (target.closest('.monchip') !== null) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  const elapsed = Math.max(0, now - Date.parse(monitor.setAt))
  const sinceCheck =
    monitor.last === undefined
      ? undefined
      : longDuration(Math.max(0, now - Date.parse(monitor.last.at)))
  const output = monitor.last?.output

  return (
    <div className="mondetail" ref={box} role="dialog" aria-label={monitor.description}>
      <div className="d">{monitor.description}</div>
      <div className="why">{monitor.reason}</div>
      <div className="facts">
        <span>check</span>
        <span>
          every <b>{briefDuration(monitor.intervalMs)}</b> ·{' '}
          {sinceCheck === undefined ? (
            <>no check has finished yet</>
          ) : (
            <>
              last <b>{sinceCheck} ago</b>
            </>
          )}{' '}
          · <b>{monitor.checks}</b> {monitor.checks === 1 ? 'check' : 'checks'} so far
        </span>
        <span>wake</span>
        <span>
          when the command exits <b>0</b>, or after <b>{briefDuration(monitor.timeoutMs)}</b>{' '}
          regardless
        </span>
        <span>where</span>
        <span>
          {monitor.cwd} ({where})
        </span>
      </div>
      <pre className="moncmd">{monitor.command}</pre>
      <div className="facts">
        <span>last output</span>
        <span className="monout">
          {output === undefined || output.text === '' ? '(nothing yet)' : output.text}
          {output?.truncated === true ? ' …' : ''}
        </span>
      </div>
      <div className="bar" aria-hidden="true">
        <i style={{ width: `${Math.round(elapsedFraction(monitor, now) * 100)}%` }} />
      </div>
      <div className="foot">
        <span>{elapsedOfTimeout(elapsed, monitor.timeoutMs)}</span>
        <button className="btn stop" onClick={onStop}>
          Stop watching
        </button>
      </div>
    </div>
  )
}
