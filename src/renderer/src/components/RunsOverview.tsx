import type { SessionState, WorkspaceState } from '../../../shared/agent/port'
import {
  currentNode,
  runCost,
  runIsLive,
  type RunRecord
} from '../../../shared/workflows/run'
import { UNTITLED } from '../labels'
import { money, shortAge } from '../runs/format'
import './runs.css'

// Every run across every workspace, grouped by workspace, sessions named
// (Q15). A run with an orchestrator gets Go to session; a session-less run
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
  const groups = groupByWorkspace(runs)
  const running = runs.filter((run) => run.status === 'running' && run.waiting !== true).length
  const waiting = runs.filter((run) => runIsLive(run) && run.waiting === true).length
  const finished = finishedToday(runs)

  return (
    <section className="runsoverview" aria-label="All runs">
      <header className="gvtop">
        <span className="t">Runs</span>
        <span className="count">
          {running} running · {waiting} waiting · {finished} finished today
        </span>
        <button className="btn x" onClick={onClose}>
          esc
        </button>
      </header>
      <div className="gvbody">
        {groups.length === 0 ? (
          <p className="gvempty">
            No runs yet. An agent starts one with the crucible_run tool; ask for a workflow in
            any session.
          </p>
        ) : (
          groups.map((group) => (
            <div className="wsgroup" key={group.name}>
              <div className="wsname">{group.name}</div>
              {group.runs.map((run) => {
                const session =
                  run.sessionId === undefined
                    ? undefined
                    : sessions.find((candidate) => candidate.id === run.sessionId)
                const workspace = workspaces.find(
                  (candidate) => candidate.path === run.workspacePath
                )
                const parked = runIsLive(run) && run.waiting === true
                const done = !runIsLive(run)
                return (
                  <div
                    className={`runrow${parked ? ' parked' : ''}${done ? ' done' : ''}`}
                    key={run.id}
                  >
                    <span className={`dot ${run.status}`} />
                    <span className="wf">{run.workflow}</span>
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
  return `${run.status} · ${shortAge(run.endedAt)} ago`
}

function finishedToday(runs: readonly RunRecord[], now = Date.now()): number {
  return runs.filter(
    (run) =>
      !runIsLive(run) &&
      run.endedAt !== undefined &&
      now - new Date(run.endedAt).getTime() < 24 * 3_600_000
  ).length
}

interface Group {
  readonly name: string
  readonly runs: readonly RunRecord[]
}

function groupByWorkspace(runs: readonly RunRecord[]): readonly Group[] {
  const groups = new Map<string, RunRecord[]>()
  for (const run of runs) {
    const held = groups.get(run.workspaceName)
    if (held === undefined) groups.set(run.workspaceName, [run])
    else held.push(run)
  }
  return [...groups.entries()].map(([name, grouped]) => ({ name, runs: grouped }))
}
