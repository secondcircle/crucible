import { useState } from 'react'
import type { SessionState, WorkspaceState } from '../../../shared/agent/port'
import { currentNode, runIsLive, runCost, type RunRecord } from '../../../shared/workflows/run'
import { UNTITLED } from '../labels'
import { bandsOf, runsHeadline } from '../runs/bands'
import { money, shortAge, since } from '../runs/format'
import { InvestigateButton } from './InvestigateButton'
import './runs.css'

// Every run across every workspace, in three bands: running, needs you, done.
// A run with an orchestrator gets Go to session, and the record outlives the
// run, so finished work is reachable here too.
//
// Two acts clear a row without opening anything. One button, two states, on
// the Needs-you rows: Cancel stops a live or paused run after a confirm,
// Dismiss clears a settled one that is asking for attention it no longer
// deserves. Investigate is on every row in every band — it starts a session
// that already knows the run, and takes the session-less row's primary slot,
// where a blank fresh chat used to sit.
export function RunsOverview({
  runs,
  workspaces,
  sessions,
  onOpenRun,
  onGoToSession,
  onDismiss,
  onCancel,
  onInvestigate,
  onClose
}: {
  readonly runs: readonly RunRecord[]
  readonly workspaces: readonly WorkspaceState[]
  readonly sessions: readonly SessionState[]
  readonly onOpenRun: (runId: string) => void
  readonly onGoToSession: (sessionId: string) => void
  /** Clears a settled run. No confirm: nothing is destroyed by it. */
  readonly onDismiss: (runId: string) => Promise<void>
  // Raises the app's confirm and answers with what the user chose, so the
  // button knows whether the run is on its way out or still working.
  readonly onCancel: (runId: string) => Promise<'cancelled' | 'kept'>
  readonly onInvestigate: (runId: string) => Promise<void>
  readonly onClose: () => void
}): React.JSX.Element {
  const bands = bandsOf(runs)
  // Rows whose Dismiss or Cancel is done being clicked: the button is dead
  // from that frame until the snapshot re-bands the row out of Needs you and
  // takes the button with it (ADR 0010).
  const [acting, setActing] = useState<readonly string[]>([])
  const clearing = (runId: string): boolean => acting.includes(runId)
  const markActing = (runId: string): void => setActing((current) => [...current, runId])
  const unmarkActing = (runId: string): void =>
    setActing((current) => current.filter((held) => held !== runId))

  return (
    <section className="runsoverview" aria-label="All runs">
      <header className="gvtop">
        <span className="t">Runs</span>
        <span className="count">{runsHeadline(runs)}</span>
        <button className="btn x" onClick={onClose}>
          esc
        </button>
      </header>
      <div className="gvbody">
        {runs.length === 0 ? (
          <p className="gvempty">
            No runs yet. An agent starts one with the crucible_run tool; ask for a workflow in
            any session.
          </p>
        ) : (
          bands.map((band) => (
            <div className="band" key={band.band}>
              <div className="bandhead">
                <span className={`n${band.band === 'needsYou' ? ' hot' : ''}`}>{band.name}</span>
                <span className="rule" />
                <span className="k">{band.runs.length}</span>
              </div>
              {band.runs.map((run) => {
                const session =
                  run.sessionId === undefined
                    ? undefined
                    : sessions.find((candidate) => candidate.id === run.sessionId)
                const workspace = workspaces.find(
                  (candidate) => candidate.path === run.workspacePath
                )
                const live = runIsLive(run)
                const parked = live && run.waiting === true
                const dismissed = run.dismissedAt !== undefined
                // A failed run has its own treatment and is never dimmed —
                // until it is dismissed, which is the whole point of
                // dismissing: the row stops shouting.
                const failed = run.status === 'failed' && !dismissed
                const done =
                  dismissed || run.status === 'complete' || run.status === 'cancelled'
                return (
                  <div
                    className={`runrow${parked ? ' parked' : ''}${failed ? ' failed' : ''}${
                      done ? ' done' : ''
                    }`}
                    key={run.id}
                  >
                    <span className={`dot ${run.status}`} />
                    <span className="wf">{run.workflow}</span>
                    <span className="ws">{run.workspaceName}</span>
                    <span className="id">{run.id}</span>
                    <span className="st">{statusText(run)}</span>
                    <span className="sess">
                      {run.sessionId !== undefined ? (
                        <>
                          from <em>{session?.title ?? UNTITLED}</em>
                        </>
                      ) : (
                        <span className="un">unattended</span>
                      )}
                    </span>
                    <span className="spend">{money(runCost(run))}</span>
                    <button className="btn" onClick={() => onOpenRun(run.id)}>
                      Open run
                    </button>
                    {run.sessionId !== undefined && session !== undefined ? (
                      <button className="btn" onClick={() => onGoToSession(session.id)}>
                        Go to session
                      </button>
                    ) : null}
                    {/* One button, two states, and only where the run is
                        asking: a Done row asks nothing, and a healthy Running
                        row is not asking either. */}
                    {band.band !== 'needsYou' ? null : live ? (
                      <button
                        className="btn"
                        disabled={clearing(run.id)}
                        onClick={() => {
                          void onCancel(run.id).then((chose) => {
                            if (chose === 'cancelled') markActing(run.id)
                          })
                        }}
                      >
                        Cancel
                      </button>
                    ) : (
                      <button
                        className="btn"
                        disabled={clearing(run.id)}
                        onClick={() => {
                          markActing(run.id)
                          void onDismiss(run.id).catch(() => unmarkActing(run.id))
                        }}
                      >
                        Dismiss
                      </button>
                    )}
                    <InvestigateButton
                      run={run}
                      workspaceOpen={workspace !== undefined}
                      primary={run.sessionId === undefined}
                      onInvestigate={() => onInvestigate(run.id)}
                    />
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>
    </section>
  )
}

function statusText(run: RunRecord): string {
  if (runIsLive(run)) {
    if (run.waiting === true) {
      const who = run.sessionId === undefined ? 'no one to ask' : 'waiting on its agent'
      return `⚑ ${who} · ${shortAge(run.question?.raisedAt ?? run.startedAt)}`
    }
    if (run.status === 'paused') return 'paused'
    const node = currentNode(run)
    return `▸ ${node?.id ?? '…'} · ${shortAge(run.startedAt)}`
  }
  // The row says it was dismissed, beside the status it still holds: a
  // dismissal clears a run, it does not rewrite how the run ended.
  const cleared = run.dismissedAt === undefined ? '' : ' · dismissed'
  return `${run.status}${cleared} · ${since(run.endedAt)}`
}
