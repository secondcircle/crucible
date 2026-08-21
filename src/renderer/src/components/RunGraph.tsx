import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RunNode } from '../../../shared/workflows/run'
import { cardFace, edgeState, graphCount, layOutGraph } from '../runs/graph'
import './runs.css'

// The run graph, drawn: one card per node, one line per edge, layered
// top-down from the record alone. Read-only like the rest of the run view —
// a click selects a node and nothing here runs, re-runs or edits anything.

/** Mirrors the horizontal padding `.gscroll` draws around the canvas. */
const CANVAS_PAD = 26

/** Past this the cards stop being legible, so fit stops and the pane scrolls. */
const MIN_SCALE = 0.6

export function RunGraph({
  nodes,
  shownId,
  fullScreen,
  onPick,
  onToggleFullScreen
}: {
  readonly nodes: readonly RunNode[]
  /** The node the detail column is showing, whose own edges are lit. */
  readonly shownId: string | undefined
  readonly fullScreen: boolean
  readonly onPick: (nodeId: string) => void
  readonly onToggleFullScreen: () => void
}): React.JSX.Element {
  const layout = useMemo(() => layOutGraph(nodes), [nodes])
  // Per open view, never persisted: a graph opens fit, whatever the last one
  // was left at.
  const [unscaled, setUnscaled] = useState(false)
  const scroll = useRef<HTMLDivElement>(null)
  const room = usePaneWidth(scroll)

  // Fit scales down to the floor and no further, and never scales up: a
  // three-node graph is not blown up to fill a pane.
  const fitted =
    room === 0 ? 1 : Math.max(MIN_SCALE, Math.min(1, room / Math.max(1, layout.width)))
  const scale = unscaled ? 1 : fitted

  // A node still working shows how long it has been at it, which no snapshot
  // announces: that number only moves because the clock does.
  const now = useClock(
    nodes.some((node) => node.startedAt !== undefined && node.endedAt === undefined)
  )

  return (
    <section className={`gpane${fullScreen ? ' full' : ''}`} aria-label="Run graph">
      <div className="ghead">
        <span className="t">Graph</span>
        <span className="c">{graphCount(nodes)}</span>
        <span className="sp">
          <button
            className={`pill${unscaled ? '' : ' on'}`}
            onClick={() => setUnscaled(false)}
            aria-pressed={!unscaled}
          >
            {fitted === 1 || unscaled ? 'fit' : `fit ${Math.round(fitted * 100)}%`}
          </button>
          <button
            className={`pill${unscaled ? ' on' : ''}`}
            onClick={() => setUnscaled(true)}
            aria-pressed={unscaled}
          >
            100%
          </button>
          <button className="pill" onClick={onToggleFullScreen}>
            {fullScreen ? '⤢ exit full screen' : '⤢ full screen'}
          </button>
        </span>
      </div>

      <div className="gscroll" ref={scroll}>
        <div
          className="canvas"
          style={{ width: layout.width * scale, height: layout.height * scale }}
        >
          <div
            className="cstage"
            style={{
              width: layout.width,
              height: layout.height,
              transform: scale === 1 ? undefined : `scale(${scale})`
            }}
          >
            {/* No text, no hover, no click: what passed between two nodes is
                the artifact rail's job, and a line says only that it did. */}
            <svg
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              aria-hidden="true"
            >
              {layout.edges.map((edge) => (
                <path
                  key={`${edge.from}→${edge.to}`}
                  className={edgeClass(edge, nodes, shownId)}
                  d={edge.d}
                />
              ))}
            </svg>

            {layout.cards.map((card) => {
              const face = cardFace(card.node, now)
              return (
                <button
                  key={card.id}
                  className={`nd ${face.tone}${shownId === card.id ? ' sel' : ''}`}
                  style={{
                    left: card.x,
                    top: card.y,
                    width: layout.cardWidth,
                    height: layout.cardHeight
                  }}
                  onClick={() => onPick(card.id)}
                >
                  <span className="ndtop">
                    <span className="nm">{face.id}</span>
                    <span className="st">{face.status}</span>
                  </span>
                  {face.facts === undefined ? null : <span className="facts">{face.facts}</span>}
                  {face.verdict === undefined ? null : (
                    <span className={`vd ${face.verdict.tone}`}>{face.verdict.text}</span>
                  )}
                  {face.now === undefined ? null : <span className="now">▸ {face.now}</span>}
                  {face.error === undefined ? null : <span className="err">{face.error}</span>}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}

/** The four states, in shape as well as hue; the first that matches wins. */
function edgeClass(
  edge: { readonly from: string; readonly to: string },
  nodes: readonly RunNode[],
  shownId: string | undefined
): string {
  switch (edgeState(edge, nodes, shownId)) {
    case 'selected':
      return 'e lit'
    case 'planned':
      return 'e future'
    case 'walking': {
      // The march is work happening; a parked node holds the teal line still.
      const child = nodes.find((node) => node.id === edge.to)
      return child?.status === 'running' ? 'e flowing' : 'e flowing still'
    }
    default:
      return 'e'
  }
}

/** The room the canvas has, which is what fit measures itself against. */
function usePaneWidth(pane: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const element = pane.current
    if (element === null) return
    const measure = (): void => setWidth(Math.max(0, element.clientWidth - 2 * CANVAS_PAD))
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [pane])

  return width
}

/** Kept honest without a render every second, and none at all once nothing moves. */
function useClock(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}
