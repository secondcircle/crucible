import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TranscriptItem } from '../../../shared/agent/port'
import {
  baseNodeId,
  currentNode,
  nextRevisionId,
  resumePlan,
  runCost,
  runIsLive,
  runStop,
  stoppedNodes,
  type ResumeKind,
  type RunArtifact,
  type RunNode,
  type RunRecord,
  type RunStop
} from '../../../shared/workflows/run'
import { artifactName } from '../../../shared/workflows/artifacts'
import { waitedFor } from '../monitors/activity'
import type { ArtifactView } from '../../../shared/workflows/service'
import { money, nodeProgress, shortAge, shortModel, since } from '../runs/format'
import { transcriptWithSeams } from '../runs/seams'
import { railOf, rowFor, type RailModel } from '../runs/rail'
import { relativeTime } from '../labels'
import { useClock } from '../clock'
import { ArtifactRail } from './ArtifactRail'
import { ArtifactReader } from './ArtifactReader'
import { InvestigateButton } from './InvestigateButton'
import { RunGraph } from './RunGraph'
import { Transcript } from './Transcript'
import './runs.css'
import './monitors.css'

/** What the graph pane is worth before anyone has dragged it. */
const DEFAULT_GRAPH_WIDTH = 640

/** Below these the two columns stop being what they are. */
const MIN_GRAPH = 360
const MIN_DETAIL = 400

/** The splitter's own width and the rail's, as runs.css draws them. */
const SPLITTER = 5
const RAIL = 273

// One value for the whole app, in the profile's own storage: a dev launch and
// the installed app keep their own userData, so neither can move the other's
// splitter.
const WIDTH_KEY = 'crucible.run-graph-width'

// Full screen puts the detail column away without taking it apart, so leaving
// it again lands on the same transcript, scrolled where it was.
const HIDDEN: React.CSSProperties = { display: 'none' }

// The full-screen dig: read-only observability plus the mechanical Pause,
// Cancel and Resume, with Investigate beside them. The graph is layered
// top-down; a node's transcript renders through the chat pane's own component,
// tool chains collapsed; the routed banner shows what was asked and where it
// went — never an input box. Talking happens in the session; Go to session is
// the door.
export function WorkflowRunView({
  run,
  canGoToSession,
  workspaceOpen,
  transcript,
  artifact,
  openArtifact,
  onOpenArtifact,
  onRevealArtifact,
  onCopyPath,
  onGoToSession,
  onPause,
  onResume,
  onCancel,
  onInvestigate,
  onClose,
  fullScreen,
  onToggleFullScreen
}: {
  readonly run: RunRecord
  readonly canGoToSession: boolean
  /** Whether the run's workspace is open, which Investigate needs. */
  readonly workspaceOpen: boolean
  /** Reads one node's transcript; called again as the node moves. */
  readonly transcript: (nodeId: string) => Promise<readonly TranscriptItem[]>
  /** Reads one artifact of this run, gated on its record. */
  readonly artifact: (path: string) => Promise<ArtifactView>
  // The artifact the reader is showing, by path, and the way to change it.
  // Held above this view because Escape unwinds the reader before the view.
  readonly openArtifact: string | undefined
  readonly onOpenArtifact: (path: string | undefined) => void
  readonly onRevealArtifact: (path: string) => void
  readonly onCopyPath: (path: string) => void
  readonly onGoToSession: () => void
  readonly onPause: () => void
  // Un-pauses a paused run, and puts a stopped one back to work — continuing
  // the node it stopped on, or starting that node over. It resolves when the
  // act has landed either way, which is what takes the buttons out of their
  // waiting state.
  readonly onResume: (kind: ResumeKind) => Promise<void>
  /** Raises the same confirm the run row raises; stopping never goes silent. */
  readonly onCancel: () => void
  /** The same flow the row's Investigate runs, landing in a new session. */
  readonly onInvestigate: () => Promise<void>
  readonly onClose: () => void
  // Held above this view, like the open artifact: Escape unwinds full screen
  // before the reader, and the reader before the run.
  readonly fullScreen: boolean
  readonly onToggleFullScreen: () => void
}): React.JSX.Element {
  // Follows the run's own frontier until the user picks a node; their pick
  // then stands until they pick again or the node leaves the record.
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const shown =
    (picked === undefined ? undefined : run.nodes.find((node) => node.id === picked)) ??
    currentNode(run) ??
    run.nodes[0]

  const now = useClock(shown?.waitingOn !== undefined)

  const [items, setItems] = useState<readonly TranscriptItem[]>([])
  const fetchedFor = useRef<string>('')

  // Re-read when the shown node changes or its activity moves; the key
  // carries both so a quiet node is not re-fetched every render.
  const transcriptKey =
    shown === undefined
      ? ''
      : `${run.id}:${shown.id}:${shown.lastActivityAt ?? ''}:${shown.status}`
  useEffect(() => {
    if (shown === undefined || transcriptKey === fetchedFor.current) return
    const key = transcriptKey
    fetchedFor.current = key
    // Staleness is judged by key, not by effect lifetime: snapshot events
    // re-render this component mid-fetch, and a cleanup flag would drop the
    // very answer the view is waiting for.
    void transcript(shown.id)
      .then((read) => {
        if (fetchedFor.current === key) setItems(read)
      })
      .catch(() => {
        // A node with no transcript yet shows an empty pane, not an error.
        if (fetchedFor.current === key) setItems([])
      })
  }, [shown, transcriptKey, transcript])

  const live = runIsLive(run)
  // Set from the click to the act's answer, so the buttons say they heard in
  // the same frame and neither can be clicked while the other is in flight.
  const [resuming, setResuming] = useState(false)
  const resume = (kind: ResumeKind): void => {
    setResuming(true)
    void onResume(kind)
      .catch(() => {
        // The refusal is reported where every run refusal is; here it only
        // means the buttons come back.
      })
      .then(() => setResuming(false))
  }
  // How this run stopped, if it has: the one fact the banner, its tint and
  // the two acts are all read from.
  const stop = runStop(run)
  // Nothing to start over on a run the stop caught between nodes, so the act
  // is not offered there; the banner says Resume alone applies.
  const canStartOver = stop !== undefined && stoppedNodes(run).length > 0
  const rail = usePlacedRail(run)
  const body = useRef<HTMLDivElement>(null)
  const { graphWidth, railShown, startDrag } = useSplitter(body)
  // The reader shows what the record still names: an artifact whose row leaves
  // the record (a pruned ghost's) puts the node's transcript back by itself.
  const openRow = openArtifact === undefined ? undefined : rowFor(rail, openArtifact)
  const cost = money(runCost(run))
  const question = run.question
  const selected =
    openArtifact !== undefined
      ? [openArtifact]
      : (shown?.artifacts ?? []).map((declared) => declared.path)

  return (
    <section className="runview" aria-label={`Run ${run.id}`}>
      <header className="rvtop">
        <span className="wf">{run.workflow}</span>
        <span className="id">run {run.id}</span>
        <span className={`stat ${run.status}`}>
          {run.status === 'interrupted' ? '◌ interrupted · app quit' : run.status}
          {/* How long it has been working, while it still is; how long ago it
              stopped, once it has. Age-since-start on a settled run reads as
              the time it took, which it is not. */}
          {live ? ageSuffix(shortAge(run.startedAt)) : ageSuffix(since(run.endedAt))}
        </span>
        <span className="where">
          {run.branch === undefined ? null : <b>{run.branch}</b>}
          {run.baseCommit === undefined ? null : <> · from <b>{run.baseCommit.slice(0, 7)}</b></>}
        </span>
        <span className="spend">
          {cost === '' ? '' : `${cost} · `}
          {nodeProgress(run)}
        </span>
        {canGoToSession ? (
          // Quiet while the run is stopped: Resume is the one primary there,
          // because it is the one act that moves the run.
          <button
            className={`btn${stop === undefined ? ' primary' : ''}`}
            onClick={onGoToSession}
          >
            Go to session
          </button>
        ) : null}
        {live ? (
          run.status === 'paused' ? (
            <button className="btn" disabled={resuming} onClick={() => resume('continue')}>
              Resume
            </button>
          ) : (
            <button className="btn" onClick={onPause}>
              Pause
            </button>
          )
        ) : null}
        {live ? (
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        {/* The two acts, in the slot Pause and Cancel occupy on a live run:
            there is no live handle here to pause or to cancel, and these are
            the acts that move the run. One set of buttons on every stop. */}
        {stop === undefined ? null : (
          <button className="btn primary" disabled={resuming} onClick={() => resume('continue')}>
            Resume
          </button>
        )}
        {canStartOver ? (
          <button className="btn" disabled={resuming} onClick={() => resume('clean-restart')}>
            Start node over
          </button>
        ) : null}
        {/* On every status: what happened is a question worth asking of a
            finished run as much as a stuck one. */}
        <InvestigateButton
          run={run}
          workspaceOpen={workspaceOpen}
          onInvestigate={onInvestigate}
        />
        <button className="btn" onClick={onClose}>
          esc
        </button>
      </header>

      <div className="rvbody" ref={body}>
        {/* The graph is the last thing to yield room: full screen takes the
            whole body, and on a narrow window the rail goes before the
            splitter clamps this down. */}
        <div className="gwrap" style={{ width: fullScreen ? '100%' : graphWidth }}>
          <RunGraph
            nodes={run.nodes}
            shownId={shown?.id}
            fullScreen={fullScreen}
            onToggleFullScreen={onToggleFullScreen}
            onPick={(nodeId) => {
              // Picking a node in the graph is also a way out of the
              // reader: that node's transcript is what it asks for.
              onOpenArtifact(undefined)
              setPicked(nodeId)
            }}
          />
        </div>

        {fullScreen ? null : (
          <div
            className="split"
            role="separator"
            aria-label="Resize the run graph"
            aria-orientation="vertical"
            onMouseDown={startDrag}
          />
        )}

        <div className="detail" style={fullScreen ? HIDDEN : undefined}>
          {stop === undefined ? null : (
            <StopBanner run={run} stop={stop} toSession={canGoToSession} />
          )}
          {openRow !== undefined ? (
            <ArtifactReader
              runId={run.id}
              row={openRow}
              read={artifact}
              onReveal={onRevealArtifact}
              onCopyPath={onCopyPath}
              onClose={() => onOpenArtifact(undefined)}
            />
          ) : shown === undefined ? (
            <p className="rvempty">This run recorded no nodes.</p>
          ) : (
            <>
              <div className="dhead">
                <div className="n">{shown.id}</div>
                <div className="facts">
                  {shown.model === undefined ? null : (
                    <span>
                      model <b>{shortModel(shown.model)}</b>
                    </span>
                  )}
                  {shown.toolCalls === undefined ? null : (
                    <span>
                      tools <b>{shown.toolCalls}</b>
                    </span>
                  )}
                  {shown.contextPercent === undefined ? null : (
                    <span>
                      ctx <b>{shown.contextPercent}%</b>
                    </span>
                  )}
                  {shown.cost === undefined ? null : (
                    <span>
                      cost <b>{money(shown.cost)}</b>
                    </span>
                  )}
                  {shown.lastActivityAt === undefined ? null : (
                    <span>
                      last activity <b>{relativeTime(shown.lastActivityAt)}</b>
                    </span>
                  )}
                </div>
                {shown.waitingOn === undefined ? null : (
                  <div className="waiting">
                    ⏳ {shown.waitingOn.description} · {waitedFor(shown.waitingOn.since, now)}
                  </div>
                )}
                {shown.now === undefined ? null : <div className="now">▸ {shown.now}</div>}
                {shown.error === undefined ? null : (
                  <div className="nodeerror">{shown.error}</div>
                )}
              </div>

              <Transcript
                items={transcriptWithSeams(run, shown, items, now)}
                sessionId={`run-${run.id}-${shown.id}`}
              />

              <NodeStrip run={run} node={shown} onOpen={onOpenArtifact} />
            </>
          )}

          {question === undefined || run.waiting !== true ? null : (
            <div className="routed" role="status">
              <b>⚑ {question.nodeId === undefined ? 'Check-in' : `Blocked · ${question.nodeId}`}</b>
              <span className="q">{firstLine(question.reason)}</span>
              <span className="to">
                → sent to this run's orchestrator · {relativeTime(question.raisedAt)}
              </span>
              {canGoToSession ? (
                <button className="btn" onClick={onGoToSession}>
                  Go to session
                </button>
              ) : null}
            </div>
          )}
        </div>

        {fullScreen || !railShown ? null : (
          <ArtifactRail rail={rail} selected={selected} onOpen={onOpenArtifact} />
        )}
      </div>
    </section>
  )
}

/**
 * The width the graph pane is given, and what a drag on the splitter does to
 * it. The set width is remembered for the whole app; what the pane actually
 * gets is that width against the room the window has, where the rail yields
 * before the graph does.
 */
function useSplitter(body: React.RefObject<HTMLDivElement | null>): {
  readonly graphWidth: number
  readonly railShown: boolean
  readonly startDrag: (pressed: React.MouseEvent) => void
} {
  const [wanted, setWanted] = useState(rememberedWidth)
  const [room, setRoom] = useState(0)
  // Set for as long as a drag is under way, so a view that goes away mid-drag
  // takes its listeners with it.
  const endDrag = useRef<(() => void) | undefined>(undefined)

  useLayoutEffect(() => {
    const element = body.current
    if (element === null) return
    const measure = (): void => setRoom(element.getBoundingClientRect().width)
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [body])

  useEffect(() => () => endDrag.current?.(), [])

  // An unmeasured body (nothing laid out yet) is treated as roomy: the pane
  // gets what it asked for rather than collapsing to its minimum.
  const ceiling =
    room === 0 ? Number.POSITIVE_INFINITY : Math.max(MIN_GRAPH, room - SPLITTER - MIN_DETAIL)
  const railShown = room === 0 || room - wanted - SPLITTER - MIN_DETAIL >= RAIL
  const forRail = railShown && room !== 0 ? RAIL : 0
  const graphWidth = Math.max(MIN_GRAPH, Math.min(wanted, ceiling - forRail))

  const startDrag = useCallback(
    (pressed: React.MouseEvent): void => {
      if (endDrag.current !== undefined) return
      // Without this the press begins a native selection drag, which is what
      // takes the col-resize cursor away and highlights text while resizing.
      pressed.preventDefault()
      const style = document.body.style
      const selection = style.userSelect
      style.userSelect = 'none'
      const left = body.current?.getBoundingClientRect().left ?? 0

      // The pane follows the pointer frame by frame; the profile hears about
      // it once, when the drag ends, rather than sixty times a second.
      let landed = wanted
      function onMove(moved: MouseEvent): void {
        landed = Math.max(MIN_GRAPH, Math.min(moved.clientX - left, ceiling))
        setWanted(landed)
      }
      function onUp(): void {
        endDrag.current = undefined
        style.userSelect = selection
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        try {
          window.localStorage?.setItem(WIDTH_KEY, String(Math.round(landed)))
        } catch {
          // A profile that cannot write its storage still resizes; it just
          // forgets, which beats a drag that throws.
        }
      }
      endDrag.current = onUp
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [body, ceiling, wanted]
  )

  return { graphWidth, railShown, startDrag }
}

/** What the profile remembers, or the default on a fresh one. */
function rememberedWidth(): number {
  try {
    const held = Number(window.localStorage?.getItem(WIDTH_KEY))
    if (Number.isFinite(held) && held >= MIN_GRAPH) return held
  } catch {
    // No storage in this profile: the default stands for this launch.
  }
  return DEFAULT_GRAPH_WIDTH
}

// The rail's placement memory. Each snapshot is derived against the order the
// last one produced, so a path a later node's start drops into the middle of
// the record joins the list at the end instead of pushing its neighbors down.
// The memory lives as long as the view. A run reopened later starts from
// record order again, which is the most first appearance any record can be
// asked for.
function usePlacedRail(run: RunRecord): RailModel {
  const [placed, setPlaced] = useState<{
    readonly runId: string
    readonly order: readonly string[]
  }>({ runId: run.id, order: NO_ORDER })

  const remembered = placed.runId === run.id ? placed.order : NO_ORDER
  const rail = useMemo(() => railOf(run, remembered), [run, remembered])
  const order = rail.produced.map((row) => row.path)
  // Adjusting state during render, the way React prescribes for state that
  // depends on its own last value. Deriving a snapshot against the order it
  // just produced gives that order back, so the second pass settles.
  if (placed.runId !== run.id || !sameOrder(placed.order, order)) {
    setPlaced({ runId: run.id, order })
  }
  return rail
}

const NO_ORDER: readonly string[] = []

function sameOrder(held: readonly string[], next: readonly string[]): boolean {
  return held.length === next.length && held.every((path, at) => path === next[at])
}

// What stopped this run and what each act will do about it, stated before the
// click rather than discovered after it. One banner for every stop: only the
// first sentence and the tint tell failed, cancelled and interrupted apart,
// and a failed run quotes the error it recorded.
//
// What Resume will do is not one act: the same `resumePlan` the engine and
// the interruption notice read splits the stopped nodes into the ones that
// continue from their last turn and the ones with no session left, and each
// half is described as what it is — so the sentence above the button can
// never promise a re-spend the click will not make. It names one act per node
// and not per record: a record a clean restart superseded is not a second
// node, and the engine will never reopen it. Present exactly while the run is
// stopped — resuming re-renders the column without it.
function StopBanner({
  run,
  stop,
  toSession
}: {
  readonly run: RunRecord
  readonly stop: RunStop
  /** Whether the recorded orchestrator session is still there to report to. */
  readonly toSession: boolean
}): React.JSX.Element {
  const { continued, restarted } = resumePlan(run, 'continue')
  const stopped = stoppedNodes(run)
  // Never a session that no longer exists: a run with none parks until one
  // adopts it.
  const where = toSession ? 'the same session' : 'whichever session adopts it'
  return (
    <div className={`rvwhy ${stop}`} role="status">
      <b>{headline(stop, stopped)}</b> Its worktree is left as it stands.
      {/* Where it can be read, rather than in the node facts alone: what the
          run died on is the first thing the reader is deciding from. */}
      {stop === 'failed' && run.error !== undefined ? (
        <div className="quote">{run.error}</div>
      ) : null}
      <div className="acts">
        {continued.length === 0 ? null : (
          <>
            <i>Resume</i> continues the {nodeWord(stop, continued)} {nodeNames(continued)} from{' '}
            {possessive(continued)} last turn, in the same worktree, reporting to {where}, so
            nothing {continued.length === 1 ? 'it' : 'they'} already spent is spent again.
          </>
        )}
        {restarted.length === 0 ? null : (
          <>
            {continued.length === 0 ? <i>Resume</i> : 'It'} runs the {nodeWord(stop, restarted)}{' '}
            {nodeNames(restarted)} again from {possessive(restarted)} prompt, in the same worktree
            {continued.length === 0 ? <>, reporting to {where}</> : null}: no session of{' '}
            {possessive(restarted)} own is on disk to continue from.
          </>
        )}
        {stopped.length === 0 ? (
          <>
            <i>Resume</i> puts this run back to work in the same worktree, reporting to {where}.
            Nothing was left mid-flight to start over, so Resume is the only act here.
          </>
        ) : (
          <>
            {' '}
            <i>Start node over</i> runs the {nodeWord(stop, stopped)} {nodeNames(stopped)} again
            from {possessive(stopped)} prompt with no memory of{' '}
            {stopped.length === 1 ? 'this attempt' : 'these attempts'}, as{' '}
            {revisionNames(run, stopped)}.
          </>
        )}
      </div>
    </div>
  )
}

/** The first sentence: which stop it was, and the node it stopped at. */
function headline(stop: RunStop, stopped: readonly RunNode[]): React.JSX.Element {
  // The quit's own sentence, kept: it is about the app rather than the work,
  // and it is the one the interrupted banner has always said.
  if (stop === 'interrupted') return <>Crucible quit while this run was working.</>
  const said = stop === 'failed' ? 'This run failed' : 'This run was cancelled'
  // Named here only when there is one to name; several are named by the acts
  // below instead of crowding the sentence that says what happened.
  if (stopped.length !== 1) return <>{said}.</>
  return (
    <>
      {said} at <code>{stopped[0].id}</code>.
    </>
  )
}

/** The ids a clean restart would mint, worked out where the engine works them out. */
function revisionNames(run: RunRecord, nodes: readonly RunNode[]): React.JSX.Element {
  return (
    <>
      {nodes.map((node, at) => (
        <span key={node.id}>
          {at === 0 ? null : ', '}
          <code>{nextRevisionId(run.nodes, baseNodeId(node.id))}</code>
        </span>
      ))}
    </>
  )
}

function nodeWord(stop: RunStop, nodes: readonly RunNode[]): string {
  return nodes.length === 1 ? `${stop} node` : `${stop} nodes`
}

function possessive(nodes: readonly RunNode[]): string {
  return nodes.length === 1 ? 'its' : 'their'
}

/** The node ids as code chips, em-dashed off the phrase that named them. */
function nodeNames(nodes: readonly RunNode[]): React.JSX.Element {
  return (
    <>
      —{' '}
      {nodes.map((node, at) => (
        <span key={node.id}>
          {at === 0 ? null : ', '}
          <code>{node.id}</code>
        </span>
      ))}{' '}
      —
    </>
  )
}

// Took these, made these: the node's own dataflow, one clickable chip per
// file. `making` while the node is still at it, `made` once it has settled.
function NodeStrip({
  run,
  node,
  onOpen
}: {
  readonly run: RunRecord
  readonly node: RunNode
  readonly onOpen: (path: string) => void
}): React.JSX.Element | null {
  if (node.reads.length === 0 && node.artifacts.length === 0) return null
  const inputs = new Set(Object.values(run.inputs))
  const settled = node.status === 'complete' || node.status === 'failed'

  function chip(artifact: RunArtifact, list: string, extra: string): React.JSX.Element {
    return (
      <button
        key={`${list}:${artifact.path}`}
        className={`a${extra === '' ? '' : ` ${extra}`}`}
        title={artifact.path}
        onClick={() => onOpen(artifact.path)}
      >
        {artifactName(artifact.path)}
      </button>
    )
  }

  return (
    <div className="inout">
      {node.reads.length === 0 ? null : (
        <>
          <span className="lbl">took</span>
          {node.reads.map((read) =>
            chip(read, 'took', inputs.has(read.path) ? 'in' : '')
          )}
        </>
      )}
      {node.reads.length > 0 && node.artifacts.length > 0 ? <span className="sep" /> : null}
      {node.artifacts.length === 0 ? null : (
        <>
          <span className="lbl">{settled ? 'made' : 'making'}</span>
          {node.artifacts.map((made) =>
            chip(
              made,
              'made',
              made.writtenAt === undefined && node.status !== 'complete' ? 'unwritten' : ''
            )
          )}
        </>
      )}
    </div>
  )
}

function firstLine(text: string): string {
  return text.split('\n')[0]
}

/** Nothing at all when there is no stamp to read, rather than a bare dot. */
function ageSuffix(age: string): string {
  return age === '' ? '' : ` · ${age}`
}
