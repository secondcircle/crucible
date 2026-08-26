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

// How a clearing act ended: `cleared` means the snapshot will re-band the row
// and take its button away; `kept` — declined, refused or failed, reported by
// the handler — means the run is still here and the button must come back.
export type RunActOutcome = 'cleared' | 'kept'

export function RunsOverview({
  runs,
  workspaces,
  sessions,
  onOpenRun,
  onGoToSession,
  onDismiss,
  onCancel,
  onResume,
  onInvestigate,
  onClose
}: {
  readonly runs: readonly RunRecord[]
  readonly workspaces: readonly WorkspaceState[]
  readonly sessions: readonly SessionState[]
  readonly onOpenRun: (runId: string) => void
  readonly onGoToSession: (sessionId: string) => void
  /** Clears a settled run. No confirm: nothing is destroyed by it. */
  readonly onDismiss: (runId: string) => Promise<RunActOutcome>
  // Raises the app's confirm and then does the cancelling, answering with
  // what became of the run — not with what the user clicked.
  readonly onCancel: (runId: string) => Promise<RunActOutcome>
  // Puts an interrupted run back to work: no confirm, because the click is
  // the spend authorization (ADR 0026). `cleared` when the run is working
  // again — the snapshot re-bands the row — and `kept` on a refusal.
  readonly onResume: (runId: string) => Promise<RunActOutcome>
  readonly onInvestigate: (runId: string) => Promise<void>
  readonly onClose: () => void
}): React.JSX.Element {
  const bands = bandsOf(runs)
  // Rows with a clearing act in flight. Tied to the outcome, not the click:
  // a declined, refused or failed act hands the button back rather than
  // leaving it dead on a row that still needs clearing. Counted from the
  // click, so the button under a raised confirm cannot raise a second one.
  const [acting, setActing] = useState<readonly string[]>([])
  const clearing = (runId: string): boolean => acting.includes(runId)
  const act = (runId: string, run: (runId: string) => Promise<RunActOutcome>): void => {
    setActing((current) => (current.includes(runId) ? current : [...current, runId]))
    void run(runId)
      // A handler that breaks instead of answering leaves the run where it
      // was, which is a kept run by any other name.
      .catch((): RunActOutcome => 'kept')
      .then((outcome) => {
        if (outcome === 'kept') setActing((current) => current.filter((held) => held !== runId))
      })
  }

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
                // Amber where failed is red, and dismissing it stops the
                // shouting exactly as it does for a failure. Resume works on
                // a dismissed run all the same.
                const interrupted = run.status === 'interrupted' && !dismissed
                const done =
                  dismissed || run.status === 'complete' || run.status === 'cancelled'
                return (
                  <div
                    className={`runrow${parked ? ' parked' : ''}${failed ? ' failed' : ''}${
                      interrupted ? ' interrupted' : ''
                    }${done ? ' done' : ''}`}
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
                        onClick={() => act(run.id, onCancel)}
                      >
                        Cancel
                      </button>
                    ) : (
                      <button
                        className="btn"
                        disabled={clearing(run.id)}
                        onClick={() => act(run.id, onDismiss)}
                      >
                        Dismiss
                      </button>
                    )}
                    <InvestigateButton
                      run={run}
                      workspaceOpen={workspace !== undefined}
                      // Resume is the only primary on a row that has one:
                      // it is the one act that moves the run.
                      primary={run.sessionId === undefined && run.status !== 'interrupted'}
                      onInvestigate={() => onInvestigate(run.id)}
                    />
                    {/* Rightmost, and only where the run can be resumed: the
                        one new thing an interrupted row earns. */}
                    {run.status === 'interrupted' ? (
                      <button
                        className="btn primary"
                        disabled={clearing(run.id)}
                        onClick={() => act(run.id, onResume)}
                      >
                        Resume
                      </button>
                    ) : null}
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
  // What happened, in the mock's words: the glyph, why it stopped, and how
  // long ago — which is the record's own stop time, not the age of the app.
  if (run.status === 'interrupted') {
    const cleared = run.dismissedAt === undefined ? '' : ' · dismissed'
    return `◌ interrupted · app quit${cleared} · ${shortAge(run.endedAt)}`
  }
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
