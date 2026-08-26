import { useEffect, useState } from 'react'
import type { ScheduleView, WorkspaceSchedules } from '../../../shared/schedules/service'
import { currentNode, runCost, runIsLive, type RunRecord } from '../../../shared/workflows/run'
import type { ArtifactView } from '../../../shared/workflows/service'
import { relativeTime } from '../labels'
import { money, shortAge, since } from '../runs/format'
import {
  completionLine,
  lastOutcome,
  nextFireText,
  parkedAt,
  parkedNode,
  parkedNote,
  parkedRuns,
  parkedStateCell,
  recentRuns,
  recentStateCell,
  reportArtifact,
  warningText
} from '../schedules/board'
import { ArtifactBody } from './ArtifactReader'
import './board-frame.css'
import './schedule-board.css'

// The schedule board: what the repo declares, what it fired, and what is
// waiting for a person. It reports, toggles schedules and hands runs to
// sessions. It never answers a run — a run's only voice is a message to its
// orchestrator, gained by adoption and no other way.

/** The row ages read as a clock while the board is open. */
const TICK_MS = 30_000

const PARKED_EXPLANATION =
  'The run is parked. It has no session and never talks to you here — taking it to a ' +
  'session hands it an orchestrator, and your answer travels through that agent.'

export function ScheduleBoard({
  workspaceName,
  workspacePath,
  schedules,
  runs,
  selectedRunId,
  onSelectRun,
  onSetEnabled,
  onSetAllPaused,
  onRunNow,
  onTakeToSession,
  onOpenRunView,
  onDismiss,
  artifact,
  onClose
}: {
  readonly workspaceName: string
  readonly workspacePath: string
  /** What the scheduler answered for this workspace. */
  readonly schedules?: WorkspaceSchedules
  /** Every run record; this workspace's are picked out here. */
  readonly runs: readonly RunRecord[]
  /** The run the reading pane shows; the first parked row when none is named. */
  readonly selectedRunId?: string
  readonly onSelectRun: (runId: string) => void
  readonly onSetEnabled: (workflow: string, enabled: boolean) => Promise<void>
  readonly onSetAllPaused: (paused: boolean) => Promise<void>
  readonly onRunNow: (workflow: string) => Promise<void>
  readonly onTakeToSession: (runId: string) => Promise<void>
  readonly onOpenRunView: (runId: string) => void
  readonly onDismiss: (runId: string) => Promise<void>
  readonly artifact: (runId: string, path: string) => Promise<ArtifactView>
  readonly onClose: () => void
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  // What a click did before the service answered: the toggles flip and the
  // pause acknowledges in the frame the click lands, and a refusal puts them
  // back rather than leaving a control lying about the state.
  const [toggles, setToggles] = useState<Readonly<Record<string, boolean>>>({})
  const [pausedAhead, setPausedAhead] = useState<boolean | undefined>(undefined)
  const [firing, setFiring] = useState<readonly string[]>([])
  const [taking, setTaking] = useState<string | undefined>(undefined)
  // Rows the user dismissed, gone in the same frame; the record follows.
  const [dismissed, setDismissed] = useState<readonly string[]>([])

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(tick)
  }, [])

  const allPaused = pausedAhead ?? schedules?.allPaused === true
  const declared = schedules?.schedules ?? []
  const parked = parkedRuns(runs, workspacePath).filter((run) => !dismissed.includes(run.id))
  const recent = recentRuns(runs, workspacePath).filter((run) => !dismissed.includes(run.id))
  const selected =
    [...parked, ...recent].find((run) => run.id === selectedRunId) ?? parked[0] ?? recent[0]

  const enabledOf = (view: ScheduleView): boolean => toggles[view.workflow] ?? view.enabled

  function flip(view: ScheduleView): void {
    const next = !enabledOf(view)
    setToggles((current) => ({ ...current, [view.workflow]: next }))
    void onSetEnabled(view.workflow, next).catch(() => {
      setToggles((current) => ({ ...current, [view.workflow]: !next }))
    })
  }

  function pauseAll(): void {
    const next = !allPaused
    setPausedAhead(next)
    void onSetAllPaused(next).catch(() => setPausedAhead(!next))
  }

  function fire(workflow: string): void {
    setFiring((current) => [...current, workflow])
    void onRunNow(workflow)
      .catch(() => {
        // The refusal lands on the row as its warning; nothing more to say.
      })
      .finally(() => setFiring((current) => current.filter((held) => held !== workflow)))
  }

  function take(runId: string): void {
    setTaking(runId)
    void onTakeToSession(runId).finally(() => setTaking(undefined))
  }

  function dismiss(runId: string): void {
    setDismissed((current) => [...current, runId])
    void onDismiss(runId).catch(() => {
      setDismissed((current) => current.filter((held) => held !== runId))
    })
  }

  return (
    <section className="board schedules" role="dialog" aria-label="Schedule board">
      <div className="bhead">
        <h1>Schedules</h1>
        <span className="repo">
          in <b>{workspaceName}</b>
        </span>
        <button className="x" onClick={onClose}>
          Close <kbd>esc</kbd>
        </button>
      </div>

      <div className="bsub">
        <span>Declared by the repo's workflows</span>
        <span className="src">.crucible/workflows/*.ts</span>
        <button className="pauseall" aria-pressed={allPaused} onClick={pauseAll}>
          {allPaused ? '▶ Resume all schedules' : '⏸ Pause all schedules'}
        </button>
      </div>

      <div className="split">
        <div className="scroll">
          {parked.length === 0 ? null : (
            <div className="group" aria-label="Needs you">
              <div className="ghead you">
                <h2>Needs you</h2>
                <span className="cnt">{parked.length}</span>
                <span className="why">
                  runs parked until you act — these light the chip and walk with Tab
                </span>
              </div>
              {parked.map((run) => {
                const state = parkedStateCell(run)
                const node = parkedNode(run)
                return (
                  <button
                    className={`row${run.id === selected?.id ? ' focused' : ''}`}
                    key={run.id}
                    aria-label={`Parked run ${run.id}`}
                    onClick={() => onSelectRun(run.id)}
                  >
                    <span className="rname">
                      <span className="wf">{run.workflow}</span>{' '}
                      <span className="note">— {parkedNote(run)}</span>
                    </span>
                    <span className="rnode">{node === undefined ? '' : `node: ${node}`}</span>
                    <span className="rage">{relativeTime(parkedAt(run), now)}</span>
                    <span className={`rstate ${state.tone}`}>{state.text}</span>
                  </button>
                )
              })}
            </div>
          )}

          <div className="group" aria-label="Schedules">
            <div className="ghead">
              <h2>Schedules</h2>
              <span className="cnt">{declared.length}</span>
              <span className="why">what fires, when, and the last word from each</span>
            </div>
            {schedules === undefined ? (
              <p className="reading">Reading this repository's schedules…</p>
            ) : declared.length === 0 ? (
              <p className="reading">
                No workflow here declares a schedule. A repo workflow gains one by adding a
                `schedule` field beside its inputs.
              </p>
            ) : (
              declared.map((view) => (
                <ScheduleRow
                  key={view.workflow}
                  view={view}
                  enabled={enabledOf(view)}
                  allPaused={allPaused}
                  outcome={lastOutcome(runs, workspacePath, view.workflow)}
                  firing={firing.includes(view.workflow)}
                  now={now}
                  onToggle={() => flip(view)}
                  onRunNow={() => fire(view.workflow)}
                />
              ))
            )}
          </div>

          {recent.length === 0 ? null : (
            <div className="group" aria-label="Recent runs">
              <div className="ghead">
                <h2>Recent runs</h2>
                <span className="cnt">{recent.length}</span>
                <span className="why">
                  settled runs stay until dismissed; click one to read its report
                </span>
              </div>
              {recent.map((run) => {
                const state = recentStateCell(run)
                const live = runIsLive(run)
                const node = currentNode(run)
                const spend = runCost(run)
                return (
                  <button
                    className={`row${run.id === selected?.id ? ' focused' : ''}`}
                    key={run.id}
                    aria-label={`Run ${run.id}`}
                    onClick={() => onSelectRun(run.id)}
                  >
                    <span className="rname">
                      <span className="wf">{run.workflow}</span>{' '}
                      <span className="note">— {completionLine(run)}</span>
                    </span>
                    <span className="rnode">
                      {live ? `node: ${node?.id ?? '…'}` : money(spend)}
                    </span>
                    <span className="rage">
                      {live
                        ? shortAge(run.startedAt, now)
                        : relativeTime(run.endedAt ?? run.createdAt, now)}
                    </span>
                    <span className={`rstate ${state.tone}`}>
                      {state.text}
                      {live && spend !== undefined ? ` · ${money(spend)}` : ''}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <ReadingPane
          run={selected}
          now={now}
          taking={taking === selected?.id}
          artifact={artifact}
          onTake={() => {
            if (selected !== undefined) take(selected.id)
          }}
          onOpenRunView={() => {
            if (selected !== undefined) onOpenRunView(selected.id)
          }}
          onDismiss={() => {
            if (selected !== undefined) dismiss(selected.id)
          }}
        />
      </div>
    </section>
  )
}

function ScheduleRow({
  view,
  enabled,
  allPaused,
  outcome,
  firing,
  now,
  onToggle,
  onRunNow
}: {
  readonly view: ScheduleView
  readonly enabled: boolean
  readonly allPaused: boolean
  readonly outcome: ReturnType<typeof lastOutcome>
  readonly firing: boolean
  readonly now: number
  readonly onToggle: () => void
  readonly onRunNow: () => void
}): React.JSX.Element {
  const paused = !enabled || allPaused
  const warning = view.warning
  return (
    <div className={`srow${paused ? ' off' : ''}`} aria-label={`Schedule ${view.workflow}`}>
      <span className="sname">
        {view.workflow} <span className="desc">— {view.description}</span>
      </span>
      <span className="scron">
        {view.cadence === undefined ? null : (
          <>
            <b>{view.cadence}</b> ·{' '}
          </>
        )}
        {view.cron}
        {view.hasCheck ? ' · check' : ''}
      </span>
      {warning === undefined ? (
        <span className="scron">
          {outcome === undefined
            ? ''
            : `last: ${outcome.mark} ${outcome.text} ${since(outcome.at, now)}`}
        </span>
      ) : (
        <span className="scron err">{warningText(warning, now)}</span>
      )}
      <span className={`snext${nextIsDue(view, now) ? ' due' : ''}`}>
        {paused
          ? 'paused'
          : view.nextFireAt === undefined
            ? ''
            : nextFireText(view.nextFireAt, now)}
      </span>
      {/* Run now lives on the row's hover: a schedule never blocks a manual
          run, and on a checked schedule it skips the check. */}
      {warning?.kind === 'inputs' ? (
        <span className="srun placeholder" />
      ) : (
        <button className="srun" disabled={firing} onClick={onRunNow}>
          {firing ? 'starting…' : 'Run now'}
        </button>
      )}
      <button
        className={`stog${enabled ? ' on' : ''}`}
        role="switch"
        aria-checked={enabled}
        aria-label={`${view.workflow} schedule`}
        onClick={onToggle}
      >
        <i />
      </button>
    </div>
  )
}

function nextIsDue(view: ScheduleView, now: number): boolean {
  if (view.nextFireAt === undefined) return false
  const at = new Date(view.nextFireAt).getTime()
  return !Number.isNaN(at) && at <= now
}

function ReadingPane({
  run,
  now,
  taking,
  artifact,
  onTake,
  onOpenRunView,
  onDismiss
}: {
  readonly run?: RunRecord
  readonly now: number
  readonly taking: boolean
  readonly artifact: (runId: string, path: string) => Promise<ArtifactView>
  readonly onTake: () => void
  readonly onOpenRunView: () => void
  readonly onDismiss: () => void
}): React.JSX.Element {
  const report = run === undefined ? undefined : reportArtifact(run)
  const [read, setRead] = useState<
    { readonly of: string; readonly view?: ArtifactView; readonly failure?: string } | undefined
  >(undefined)

  const of = run === undefined || report === undefined ? undefined : `${run.id}:${report.path}`
  useEffect(() => {
    if (run === undefined || report === undefined || of === undefined) return
    let current = true
    void artifact(run.id, report.path)
      .then((view) => {
        if (current) setRead({ of, view })
      })
      .catch((cause: unknown) => {
        if (current) {
          setRead({ of, failure: cause instanceof Error ? cause.message : String(cause) })
        }
      })
    return () => {
      current = false
    }
  }, [artifact, run, report, of])

  if (run === undefined) {
    return (
      <div className="read" aria-label="Run reader">
        <div className="rbody">
          <p className="quiet">Nothing selected. Click a run to read what it did.</p>
        </div>
      </div>
    )
  }

  const live = runIsLive(run)
  const waiting = live && run.waiting === true
  const parked = run.sessionId === undefined && (waiting || run.status === 'failed')
  const badge = waiting
    ? { text: '⚑ WAITING', tone: 'blocked' }
    : run.status === 'failed'
      ? { text: '✕ FAILED', tone: 'failed' }
      : // A checkmark would be a lie: the run stopped where it stood.
        run.status === 'interrupted'
        ? { text: '◌ INTERRUPTED', tone: 'blocked' }
        : live
          ? { text: '● RUNNING', tone: 'live' }
          : { text: `✓ ${run.status.toUpperCase()}`, tone: 'done' }
  const spend = runCost(run)
  const answer = read?.of === of ? read : undefined

  return (
    <div className="read" aria-label="Run reader">
      <div className="rhead">
        <div className="meta">
          <span>run {run.id}</span>
          <span className={`st ${badge.tone}`}>{badge.text}</span>
          <span>fired {relativeTime(run.createdAt, now)}</span>
          {spend === undefined ? null : (
            <span>
              {money(spend)}
              {live ? ' so far' : ''}
            </span>
          )}
        </div>
        <h3>
          {run.workflow} — {parked ? parkedNote(run) : completionLine(run)}
        </h3>
      </div>

      <div className="rbody">
        <div className="facts">
          workflow <b>{run.workflow}</b>
          {parkedNode(run) === undefined ? null : (
            <>
              {' '}
              · node <b>{parkedNode(run)}</b>
            </>
          )}
          <br />
          worktree <b>{run.worktreePath ?? '—'}</b> · base{' '}
          <b>{(run.baseCommit ?? '').slice(0, 7) || '—'}</b>
        </div>

        {parked ? (
          <>
            <div className="q">
              <div className="who">{waiting ? '⚑ the run asks' : '✕ the run failed'}</div>
              {waiting
                ? (run.question?.reason ?? 'It is waiting on an answer.')
                : (run.error ?? 'It failed with no error recorded.')}
            </div>
            <p>{PARKED_EXPLANATION}</p>
          </>
        ) : report !== undefined ? (
          <ArtifactBody
            runId={run.id}
            path={report.path}
            title={report.name}
            {...(report.writtenAt === undefined ? {} : { stamp: report.writtenAt })}
            view={answer?.view}
            failure={answer?.failure}
          />
        ) : (
          <>
            <p>{completionLine(run)}</p>
            {run.outputs === undefined ? (
              <p className="quiet">This workflow declared no report artifact.</p>
            ) : (
              <pre className="outputs">{JSON.stringify(run.outputs, null, 2)}</pre>
            )}
          </>
        )}
      </div>

      <div className="rfoot">
        <button className="act primary" disabled={taking} onClick={onTake}>
          {taking ? 'Starting a session…' : 'Take to a session →'}
        </button>
        <button className="act" onClick={onOpenRunView}>
          Open run view
        </button>
        {/* Cancel for a live run that is not parked lives in the run view,
            which owns the mechanical controls. */}
        {parked || !live ? (
          <button className="act quiet" onClick={onDismiss}>
            Dismiss
          </button>
        ) : null}
      </div>
    </div>
  )
}
