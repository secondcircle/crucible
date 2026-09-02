import {
  currentNode,
  runCacheMisses,
  runCost,
  type RunRecord
} from '../../../shared/workflows/run'
import { chipNodeLabel, money, shortAge } from '../runs/format'
import { keyLabel } from '../keys'
import './cache-strip.css'
import './runs.css'

// The bar above the chat where a session's runs live, one chip each:
// workflow, current node, age, spend, amber ⚑ when the run asked something.
// Glanceable and read-only — a chip's only affordance is opening the run.
export function RunStrip({
  runs,
  onOpen
}: {
  readonly runs: readonly RunRecord[]
  readonly onOpen: (runId: string) => void
}): React.JSX.Element | null {
  if (runs.length === 0) return null

  return (
    <div className="runstrip" role="toolbar" aria-label="Runs">
      <span className="rslabel">Runs</span>
      {runs.map((run) => {
        const node = currentNode(run)
        const cost = money(runCost(run))
        const misses = runCacheMisses(run)
        const parked = run.waiting === true || run.status === 'paused'
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
          </button>
        )
      })}
      <span className="rshint">
        click a run to open · <kbd>{keyLabel('⌘R')}</kbd> all runs
      </span>
    </div>
  )
}
