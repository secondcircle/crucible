import { useEffect, useMemo, useRef, useState } from 'react'
import type { TranscriptItem } from '../../../shared/agent/port'
import {
  currentNode,
  runCost,
  runIsLive,
  type RunNode,
  type RunRecord
} from '../../../shared/workflows/run'
import {
  money,
  nodeDuration,
  nodeProgress,
  shortAge,
  shortModel,
  toViewItems
} from '../runs/format'
import { layerNodes } from '../runs/graph'
import { relativeTime } from '../labels'
import { Transcript } from './Transcript'
import './runs.css'

// The full-screen dig: read-only observability plus the mechanical Pause and
// Cancel (ADR 0017). The graph is layered top-down (Q14); a node's
// transcript renders through the chat pane's own component, tool chains
// collapsed; the routed banner shows what was asked and where it went —
// never an input box. Talking happens in the session; Go to session is the
// door.
export function WorkflowRunView({
  run,
  canGoToSession,
  transcript,
  onGoToSession,
  onPause,
  onResume,
  onCancel,
  onClose
}: {
  readonly run: RunRecord
  readonly canGoToSession: boolean
  /** Reads one node's transcript; called again as the node moves. */
  readonly transcript: (nodeId: string) => Promise<readonly TranscriptItem[]>
  readonly onGoToSession: () => void
  readonly onPause: () => void
  readonly onResume: () => void
  readonly onCancel: () => void
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

  const layers = useMemo(() => layerNodes(run.nodes), [run.nodes])
  const live = runIsLive(run)
  const cost = money(runCost(run))
  const question = run.question

  return (
    <section className="runview" aria-label={`Run ${run.id}`}>
      <header className="rvtop">
        <span className="wf">{run.workflow}</span>
        <span className="id">run {run.id}</span>
        <span className={`stat ${run.status}`}>
          {run.status}
          {run.startedAt === undefined ? '' : ` · ${shortAge(run.startedAt)}`}
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
                  onClick={() => setPicked(node.id)}
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
          {shown === undefined ? (
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

              {shown.artifacts.length === 0 ? null : (
                <div className="artifacts">
                  Artifacts
                  {shown.artifacts.map((artifact) => (
                    <span className="a" key={artifact.name} title={artifact.path}>
                      {artifact.name}
                    </span>
                  ))}
                  <span className="anote">run artifacts live in the run's dir, not the repo</span>
                </div>
              )}
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
      </div>
    </section>
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
