import type { SessionState, WorkspaceState } from '../../../shared/agent/port'
import { currentNode, runIsLive, runCost, type RunRecord } from '../../../shared/workflows/run'
import { UNTITLED } from '../labels'
import { bandsOf, runsHeadline } from '../runs/bands'
import { money, shortAge, since } from '../runs/format'
import './runs.css'

// Every run across every workspace, in three bands: running, needs you, done
// (mock W). A run with an orchestrator gets Go to session; a session-less run
// gets Start session — a fresh chat in the run's workspace — and the record
// outlives the run, so finished work is reachable here too.
export function RunsOverview({
  runs,
  workspaces,
  sessions,
  onOpenRun,
  onGoToSession,
  onStartSession,
  onClose
}: {
  readonly runs: readonly RunRecord[]
  readonly workspaces: readonly WorkspaceState[]
  readonly sessions: readonly SessionState[]
  readonly onOpenRun: (runId: string) => void
  readonly onGoToSession: (sessionId: string) => void
  readonly onStartSession: (workspaceId: string) => void
  readonly onClose: () => void
}): React.JSX.Element {
  const bands = bandsOf(runs)

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
                const parked = runIsLive(run) && run.waiting === true
                // A failed run has its own treatment and is never dimmed:
                // done is complete and cancelled.
                const failed = run.status === 'failed'
                const done = run.status === 'complete' || run.status === 'cancelled'
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
                    ) : run.sessionId === undefined && workspace !== undefined ? (
                      <button
                        className="btn primary"
                        onClick={() => onStartSession(workspace.id)}
                      >
                        Start session
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
  if (runIsLive(run)) {
    if (run.waiting === true) {
      const who = run.sessionId === undefined ? 'no one to ask' : 'waiting on its agent'
      return `⚑ ${who} · ${shortAge(run.question?.raisedAt ?? run.startedAt)}`
    }
    if (run.status === 'paused') return 'paused'
    const node = currentNode(run)
    return `▸ ${node?.id ?? '…'} · ${shortAge(run.startedAt)}`
  }
  return `${run.status} · ${since(run.endedAt)}`
}
