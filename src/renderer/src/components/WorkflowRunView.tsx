import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TranscriptItem } from '../../../shared/agent/port'
import {
  currentNode,
  interruptedNodes,
  runCost,
  runIsLive,
  type RunArtifact,
  type RunNode,
  type RunRecord
} from '../../../shared/workflows/run'
import { artifactName } from '../../../shared/workflows/artifacts'
import { waitedFor } from '../monitors/activity'
import type { ArtifactView } from '../../../shared/workflows/service'
import {
  money,
  nodeProgress,
  shortAge,
  shortModel,
  since,
  toViewItems
} from '../runs/format'
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
  // Un-pauses a paused run, and puts an interrupted one back to work. It
  // resolves when the act has landed either way, which is what takes the
  // button out of its waiting state.
  readonly onResume: () => Promise<void>
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

  // The wait in the node header is a counter, and a counter on screen moves:
  // nothing else re-renders this view while a node sits waiting.
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
  // Set from the click to the act's answer, so the button says it heard in the
  // same frame and cannot be clicked twice.
  const [resuming, setResuming] = useState(false)
  const resume = (): void => {
    setResuming(true)
    void onResume()
      .catch(() => {
        // The refusal is reported where every run refusal is; here it only
        // means the button comes back.
      })
      .then(() => setResuming(false))
  }
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
          // Quiet while the run is interrupted: Resume is the one primary
          // there, because it is the one act that moves the run.
          <button
            className={`btn${run.status === 'interrupted' ? '' : ' primary'}`}
            onClick={onGoToSession}
          >
            Go to session
          </button>
        ) : null}
        {live ? (
          run.status === 'paused' ? (
            <button className="btn" disabled={resuming} onClick={resume}>
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
        {/* The primary, in the slot Pause and Cancel occupy on a live run:
            there is no live handle here to pause or to cancel, and this is
            the one act that moves the run. */}
        {run.status === 'interrupted' ? (
          <button className="btn primary" disabled={resuming} onClick={resume}>
            Resume
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
          {run.status === 'interrupted' ? (
            <InterruptedBanner run={run} toSession={canGoToSession} />
          ) : null}
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
                {/* A node stopped on a wait never looks like a node stopped
                    on nothing: the monitor's own words, in its own color. */}
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
                items={toViewItems(items)}
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

// What the quit did and what Resume will do about it, stated before the click
// rather than discovered after it. Present exactly while the run is
// interrupted — resuming re-renders the column without it.
function InterruptedBanner({
  run,
  toSession
}: {
  readonly run: RunRecord
  /** Whether the recorded orchestrator session is still there to report to. */
  readonly toSession: boolean
}): React.JSX.Element {
  const cut = interruptedNodes(run).map((node) => node.id)
  return (
    <div className="rvwhy" role="status">
      <b>Crucible quit while this run was working.</b> Its worktree is left as it stands. Resume
      re-runs the{' '}
      {cut.length === 1 ? 'interrupted node' : 'interrupted nodes'}
      {cut.length === 0 ? ' ' : ' — '}
      {cut.map((id, at) => (
        <span key={id}>
          {at === 0 ? null : ', '}
          <code>{id}</code>
        </span>
      ))}
      {cut.length === 0 ? '' : ' — '}
      from that node’s beginning, in the same worktree, reporting to{' '}
      {/* Never a session that no longer exists: a run with none parks until
          one adopts it. */}
      {toSession ? 'the same session' : 'whichever session adopts it'}.
    </div>
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
