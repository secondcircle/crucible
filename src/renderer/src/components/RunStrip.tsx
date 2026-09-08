import {
  currentNode,
  runCacheMisses,
  runCost,
  type RunRecord
} from '../../../shared/workflows/run'
import type { LiveMonitor } from '../../../shared/monitors/monitor'
import { chipNodeLabel, money, shortAge } from '../runs/format'
import { keyLabel } from '../keys'
import { waitedFor } from '../monitors/activity'
import { MonitorChip } from './MonitorChip'
import { MonitorDetail } from './MonitorDetail'
import './cache-strip.css'
import './runs.css'
import './monitors.css'

// The bar above the chat where a session's runs and its waits live, one chip
// each: runs first under their label, then what is being waited on under its
// own. A run chip is workflow, current node, age, spend and an amber ⚑ when
// the run asked something; a monitor chip is what is awaited, what the check
// last said, and the timing. Glanceable: a run chip opens the run, a monitor
// chip opens its detail, and the ✕ stops the wait.
export function RunStrip({
  runs,
  monitors = [],
  now,
  openMonitorId,
  checkout,
  onOpen,
  onOpenMonitor,
  onStopMonitor
}: {
  readonly runs: readonly RunRecord[]
  /** The active session's live monitors, in the snapshot's own order. */
  readonly monitors?: readonly LiveMonitor[]
  /** The window's clock, so every age in the strip moves together. */
  readonly now: number
  readonly openMonitorId?: string
  // The workspace's checkout, so the detail can say whether a monitor's fixed
  // directory is that checkout or a worktree.
  readonly checkout?: string
  readonly onOpen: (runId: string) => void
  readonly onOpenMonitor?: (monitorId: string) => void
  readonly onStopMonitor?: (monitorId: string) => void
}): React.JSX.Element | null {
  if (runs.length === 0 && monitors.length === 0) return null
  const open = monitors.find((monitor) => monitor.id === openMonitorId)
  // A strip with no monitors is exactly the strip it has always been, down to
  // the label and the hint: this feature adds a group, it does not rewrite
  // one.
  const waits = monitors.length > 0

  return (
    <>
      <div className="runstrip" role="toolbar" aria-label={waits ? 'Runs and monitors' : 'Runs'}>
        {runs.length === 0 ? null : <span className="rslabel">Runs</span>}
        {runs.map((run) => {
          const node = currentNode(run)
          const cost = money(runCost(run))
          const misses = runCacheMisses(run)
          const parked = run.waiting === true || run.status === 'paused'
          const waiting = node?.waitingOn
          return (
            <button
              key={run.id}
              className={`runchip${parked ? ' parked' : ''}`}
              onClick={() => onOpen(run.id)}
              title={`run ${run.id} · click to open`}
            >
              <span className={`dot ${run.status}`} />
              <b>{run.workflow}</b>
              <span className="node">{chipNodeLabel(run, node)}</span>
              <span className="age">
                {shortAge(run.startedAt)}
                {cost === '' ? '' : ` · ${cost}`}
              </span>
              {/* Part of the chip, not a second thing to click: what makes a
                  sub-agent's misses visible while nobody is watching the run. */}
              {misses === 0 ? null : (
                <span
                  className="miss"
                  title={`${misses} cache ${misses === 1 ? 'miss' : 'misses'} in this run`}
                >
                  ⚠ {misses}
                </span>
              )}
              {/* A run stopped on a wait never looks like a run stopped on
                  nothing: the node's own words, in the monitor color. */}
              {waiting === undefined ? null : (
                <span className="waiting" title={waiting.description}>
                  ⏳ {waiting.description} · {waitedFor(waiting.since, now)}
                </span>
              )}
            </button>
          )
        })}

        {monitors.length === 0 ? null : (
          <>
            <span className="rslabel second">Waiting on</span>
            {monitors.map((monitor) => (
              <MonitorChip
                key={monitor.id}
                monitor={monitor}
                now={now}
                open={monitor.id === openMonitorId}
                onOpen={() => onOpenMonitor?.(monitor.id)}
                onStop={() => onStopMonitor?.(monitor.id)}
              />
            ))}
          </>
        )}

        <span className="rshint">
          click a {waits ? 'chip' : 'run'} to open · <kbd>{keyLabel('⌘R')}</kbd> all runs
        </span>
      </div>

      {/* Outside the strip, which scrolls sideways and would clip it, and
          anchored to the chat column under it. Nothing renders here at all
          while no chip is open. */}
      {open === undefined ? null : (
        <MonitorDetail
          monitor={open}
          now={now}
          where={open.cwd === checkout ? 'checkout' : 'worktree'}
          onClose={() => onOpenMonitor?.(open.id)}
          onStop={() => onStopMonitor?.(open.id)}
        />
      )}
    </>
  )
}
