import { useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { entryOf, modelUses, shownReading } from '../../../shared/workflows/catalog-facts'
import { CatalogContext } from '../catalog/context'
import { modelText } from '../catalog/format'
import './workflow-name.css'

// A workflow's name, wherever the window prints one, with the catalog's
// answer one hover away: the summary, the inputs and the models, and the way
// into the full page. A name the catalog has not answered for stays plain
// text, so nothing here ever promises a card it cannot fill.

/** Long enough that sweeping the pointer across a row opens nothing. */
const SHOW_MS = 350
/** Long enough to cross the gap from the name to the card. */
const HIDE_MS = 180

export function WorkflowName({
  workspacePath,
  name,
  className,
  children
}: {
  readonly workspacePath: string
  readonly name: string
  readonly className?: string
  /** How the name is drawn, where a surface marks it up; the name itself otherwise. */
  readonly children?: React.ReactNode
}): React.JSX.Element {
  const links = useContext(CatalogContext)
  const entry = entryOf(links.snapshot, workspacePath, name)
  const anchor = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [at, setAt] = useState<{ readonly left: number; readonly top: number } | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  if (entry === undefined || links.snapshot === undefined) {
    return <span className={className}>{children ?? name}</span>
  }
  const reader = links.snapshot.reader

  function show(): void {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const box = anchor.current?.getBoundingClientRect()
      if (box === undefined) return
      setAt({ left: Math.max(8, Math.min(box.left, window.innerWidth - 368)), top: box.bottom + 6 })
    }, SHOW_MS)
  }

  function hide(): void {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setAt(undefined), HIDE_MS)
  }

  const reading = entry.kind === 'workflow' ? shownReading(entry.reading, reader) : undefined
  const uses = entry.kind === 'workflow' ? modelUses(reading, entry.plan) : []
  const inputs = entry.kind === 'workflow' ? Object.entries(entry.manifest.inputs) : []

  return (
    <>
      <span
        ref={anchor}
        className={`wfname${className === undefined ? '' : ` ${className}`}`}
        onMouseEnter={show}
        onMouseLeave={hide}
      >
        {children ?? name}
      </span>
      {at === undefined
        ? null
        : createPortal(
            // The card is rendered outside the name's own box, but React still
            // bubbles its events to whatever the name sits in — a run chip, a
            // row — so they stop here.
            <div
              className="wfcard"
              role="dialog"
              aria-label={`Workflow ${name}`}
              style={{ left: at.left, top: at.top }}
              onMouseEnter={show}
              onMouseLeave={hide}
              onClick={(clicked) => clicked.stopPropagation()}
              onMouseDown={(pressed) => pressed.stopPropagation()}
            >
              <div className="wch">
                <b>{name}</b>
                <span className="origin">{entry.origin}</span>
              </div>
              {entry.kind === 'broken' ? (
                <p className="err">This file does not load: {entry.error}</p>
              ) : (
                <>
                  <p>
                    {reading?.summary ?? entry.manifest.description}
                    {reading === undefined ? <span className="quiet"> · reading the file…</span> : null}
                  </p>
                  <div className="wck">You give it</div>
                  {inputs.length === 0 ? (
                    <p className="quiet">nothing — it takes no inputs</p>
                  ) : (
                    <ul>
                      {inputs.map(([input, what]) => (
                        <li key={input}>
                          <code>{input}</code> — {what}
                        </li>
                      ))}
                    </ul>
                  )}
                  {uses.length === 0 ? null : (
                    <>
                      <div className="wck">Models</div>
                      <ul>
                        {uses.map((use) => (
                          <li key={`${use.fact.kind}:${use.fact.model}`}>
                            <b>{modelText(use.fact.model)}</b>{' '}
                            <span className="quiet">
                              {use.fact.kind === 'default' ? 'engine default · ' : ''}
                              {use.by.join(', ')}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
              <button
                className="wcopen"
                onClick={() => {
                  setAt(undefined)
                  links.open(workspacePath, name)
                }}
              >
                Open its page in the catalog →
              </button>
            </div>,
            document.body
          )}
    </>
  )
}
