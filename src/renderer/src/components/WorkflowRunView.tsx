import { useEffect, useMemo, useRef, useState } from 'react'
import type { TranscriptItem } from '../../../shared/agent/port'
import {
  currentNode,
  runCost,
  runIsLive,
  type RunArtifact,
  type RunNode,
  type RunRecord
} from '../../../shared/workflows/run'
import { artifactName } from '../../../shared/workflows/artifacts'
import type { ArtifactView } from '../../../shared/workflows/service'
import {
  money,
  nodeDuration,
  nodeProgress,
  shortAge,
  shortModel,
  since,
  toViewItems
} from '../runs/format'
import { layerNodes } from '../runs/graph'
import { railOf, rowFor, type RailModel } from '../runs/rail'
import { relativeTime } from '../labels'
import { ArtifactRail } from './ArtifactRail'
import { ArtifactReader } from './ArtifactReader'
import { InvestigateButton } from './InvestigateButton'
import { Transcript } from './Transcript'
import './runs.css'

// The full-screen dig: read-only observability plus the mechanical Pause and
// Cancel, with Investigate beside them (ADR 0017). The graph is layered
// top-down (Q14); a node's
// transcript renders through the chat pane's own component, tool chains
// collapsed; the routed banner shows what was asked and where it went —
// never an input box. Talking happens in the session; Go to session is the
// door.
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
  onClose
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
  readonly onResume: () => void
  /** Raises the same confirm the run row raises; stopping never goes silent. */
  readonly onCancel: () => void
  /** The same flow the row's Investigate runs, landing in a new session. */
  readonly onInvestigate: () => Promise<void>
  readonly onClose: () => void
}): React.JSX.Element {
  // Follows the run's own frontier until the user picks a node; their pick
  // then stands until they pick again or the node leaves the record.
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const shown =
    (picked === undefined ? undefined : run.nodes.find((node) => node.id === picked)) ??
    currentNode(run) ??
    run.nodes[0]

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
  const layers = useMemo(() => layerNodes(run.nodes), [run.nodes])
  const rail = usePlacedRail(run)
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
          {run.status}
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
          <button className="btn primary" onClick={onGoToSession}>
            Go to session
          </button>
        ) : null}
        {live ? (
          run.status === 'paused' ? (
            <button className="btn" onClick={onResume}>
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

      <div className="rvbody">
        <div className="graph" aria-label="Run graph">
          {layers.map((layer, at) => (
            <div className="glayer" key={at}>
              {layer.map((node) => (
                <button
                  key={node.id}
                  className={`gnode ${nodeClass(node)}${shown?.id === node.id ? ' sel' : ''}`}
                  onClick={() => {
                    // Picking a node in the graph is also a way out of the
                    // reader: that node's transcript is what it asks for.
                    onOpenArtifact(undefined)
                    setPicked(node.id)
                  }}
                >
                  <span className="n">
                    <span className="s" />
                    {node.id}
                  </span>
                  <span className="meta">{nodeMeta(node)}</span>
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="detail">
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

        <ArtifactRail rail={rail} selected={selected} onOpen={onOpenArtifact} />
      </div>
    </section>
  )
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

function nodeClass(node: RunNode): string {
  switch (node.status) {
    case 'complete':
      return 'done'
    case 'running':
      return 'live'
    case 'pending':
      return 'wait'
    case 'failed':
      return 'bad'
    default:
      // blocked, stalled, paused: parked states share the amber look.
      return 'parked'
  }
}

function nodeMeta(node: RunNode): string {
  if (node.status === 'pending') return 'pending'
  const verdict =
    typeof node.verdict === 'object' && node.verdict !== null && 'verdict' in node.verdict
      ? String((node.verdict as { verdict: unknown }).verdict)
      : undefined
  const parts = [
    shortModel(node.model),
    money(node.cost),
    nodeDuration(node),
    node.toolCalls === undefined || node.toolCalls === 0 ? '' : `${node.toolCalls} tools`,
    node.status === 'running' && node.contextPercent !== undefined
      ? `ctx ${node.contextPercent}%`
      : '',
    verdict === undefined ? '' : `verdict: ${verdict}`,
    node.status === 'failed' ? 'failed' : ''
  ]
  return parts.filter((part) => part !== '').join(' · ')
}

function firstLine(text: string): string {
  return text.split('\n')[0]
}

/** Nothing at all when there is no stamp to read, rather than a bare dot. */
function ageSuffix(age: string): string {
  return age === '' ? '' : ` · ${age}`
}
