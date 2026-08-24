import { useEffect, useRef, useState } from 'react'
import { runExhibitUrl } from '../../../shared/agent/exhibit-url'
import { artifactKind } from '../../../shared/workflows/artifacts'
import type { ArtifactView } from '../../../shared/workflows/service'
import { relativeTime } from '../labels'
import { fileSize } from '../runs/format'
import type { RailRow } from '../runs/rail'
import { Markdown } from './Markdown'
import './runs.css'

/** How long "Copied" stands before the button says what it does again. */
const COPIED_MS = 1400

// Read-only, like the rest of the run view: the two header actions are about
// the file, never about the run. HTML renders under an origin of its own and
// never enters this document as a string.
export function ArtifactReader({
  runId,
  row,
  read,
  onReveal,
  onCopyPath,
  onClose
}: {
  readonly runId: string
  readonly row: RailRow
  /** Reads the file now; rejects when it is gone or unreadable. */
  readonly read: (path: string) => Promise<ArtifactView>
  readonly onReveal: (path: string) => void
  readonly onCopyPath: (path: string) => void
  readonly onClose: () => void
}): React.JSX.Element {
  const written = row.state === 'written'
  const [shown, setShown] = useState<
    { readonly of: string; readonly view?: ArtifactView; readonly failure?: string } | undefined
  >(undefined)
  const [copied, setCopied] = useState(false)

  // A written artifact is read at open time and again when a slot the reader
  // is watching fills; nothing tails the file.
  const of = `${runId}:${row.path}:${row.writtenAt ?? ''}`
  useEffect(() => {
    if (!written) return
    let current = true
    void read(row.path)
      .then((view) => {
        if (current) setShown({ of, view })
      })
      .catch((cause: unknown) => {
        if (current) {
          setShown({ of, failure: cause instanceof Error ? cause.message : String(cause) })
        }
      })
    return () => {
      current = false
    }
  }, [read, row.path, of, written])

  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  // Nothing of another artifact is ever shown under this one's name.
  const answer = shown?.of === of ? shown : undefined

  return (
    <section className="reader" aria-label={`Artifact ${row.name}`}>
      <div className="rdhead">
        <span className="nm">{row.name}</span>
        <span className="by">{headline(row, answer?.view)}</span>
        {written ? (
          <button className="btn" onClick={() => onReveal(row.path)}>
            Reveal in Finder
          </button>
        ) : null}
        <button
          className="btn"
          onClick={() => {
            setCopied(true)
            clearTimeout(copyTimer.current)
            copyTimer.current = setTimeout(() => setCopied(false), COPIED_MS)
            onCopyPath(row.path)
          }}
        >
          {copied ? 'Copied' : 'Copy path'}
        </button>
        <button className="esc" onClick={onClose}>
          <kbd>esc</kbd> back to the node
        </button>
      </div>
      <div className="rdpath">{row.path}</div>
      <Body runId={runId} row={row} view={answer?.view} failure={answer?.failure} />
    </section>
  )
}

function Body({
  runId,
  row,
  view,
  failure
}: {
  readonly runId: string
  readonly row: RailRow
  readonly view: ArtifactView | undefined
  readonly failure: string | undefined
}): React.JSX.Element {
  if (row.state !== 'written') {
    return (
      <div className="rdbody">
        <p className="quiet">
          {row.state === 'never'
            ? 'This file was never written.'
            : 'This file has not been written yet.'}
        </p>
      </div>
    )
  }
  return (
    <ArtifactBody
      runId={runId}
      path={row.path}
      title={row.name}
      stamp={row.writtenAt}
      view={view}
      failure={failure}
    />
  )
}

// One written artifact's content, whichever kind it is: the machinery the run
// view's reader and the schedule board's reading pane share, so a report
// renders the same in both.
export function ArtifactBody({
  runId,
  path,
  title,
  stamp,
  view,
  failure
}: {
  readonly runId: string
  readonly path: string
  /** What the frame is titled, which is the artifact's name. */
  readonly title: string
  /** When it was written; part of the frame's key so a rewrite refetches. */
  readonly stamp?: string
  readonly view: ArtifactView | undefined
  readonly failure: string | undefined
}): React.JSX.Element {
  // The frame mounts before anything is read, because the document it loads
  // never crosses into this origin: main serves it, keyed so a re-open
  // refetches.
  if (artifactKind(path) === 'html') {
    return (
      <iframe
        key={`${runId}:${path}:${stamp ?? ''}`}
        className="frame"
        sandbox="allow-scripts"
        title={title}
        src={runExhibitUrl(runId, path)}
      />
    )
  }
  if (failure !== undefined) {
    return (
      <div className="rdbody">
        <p className="quiet">{failure}</p>
      </div>
    )
  }
  if (view === undefined) {
    return (
      <div className="rdbody">
        <p className="quiet">Reading…</p>
      </div>
    )
  }
  if (artifactKind(path) === 'markdown') {
    return (
      <div className="rdbody">
        <Markdown markdown={view.body ?? ''} />
      </div>
    )
  }
  return (
    <div className="rdbody">
      <p className="rdtext">{view.body ?? ''}</p>
    </div>
  )
}

/** What the header says about where this file came from and when. */
function headline(row: RailRow, view: ArtifactView | undefined): React.JSX.Element {
  const size = view === undefined ? '' : ` · ${fileSize(view.bytes)}`
  if (row.state === 'never') {
    return <>never written · {row.producer} failed</>
  }
  if (row.state !== 'written') {
    return <>{notWritten(row)}</>
  }
  if (row.kind === 'input') {
    return <>handed in at kickoff{size}</>
  }
  const at = row.writtenAt ?? view?.modifiedAt
  return (
    <>
      written by <b>{row.producer}</b>
      {at === undefined ? '' : ` · ${relativeTime(at)}`}
      {size}
    </>
  )
}

function notWritten(row: RailRow): string {
  return `not written yet · ${row.producer} ${row.producerStatus}`
}
