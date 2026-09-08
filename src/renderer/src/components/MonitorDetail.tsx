import { useEffect, useRef } from 'react'
import type { LiveMonitor } from '../../../shared/monitors/monitor'
import {
  briefDuration,
  elapsedOfTimeout,
  longDuration
} from '../../../shared/monitors/wording'
import { elapsedFraction } from '../monitors/activity'
import './monitors.css'

export function MonitorDetail({
  monitor,
  now,
  where,
  onClose,
  onStop
}: {
  readonly monitor: LiveMonitor
  readonly now: number
  readonly where: 'checkout' | 'worktree'
  readonly onClose: () => void
  readonly onStop: () => void
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)

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
