import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RunNode } from '../../../shared/workflows/run'
import {
  DOUBLE_CLICK_STEP,
  movedFar,
  OPENING_VIEW,
  panned,
  placementOf,
  revealed,
  wheelIntent,
  zoomedBy,
  zoomedTo,
  type Frame,
  type GraphView,
  type Point,
  type Size
} from '../runs/canvas'
import { cardFace, edgeState, graphCount, layOutGraph } from '../runs/graph'
import './runs.css'

// The run graph, drawn on a canvas: one card per node, one line per edge, the
// whole drawing moved and scaled by a single transform. Read-only like the
// rest of the run view — a click selects a node and nothing here runs, re-runs
// or edits anything. The view is this pane's own, never persisted: a graph
// opens fit and live, whatever the last one was left at.

const NO_ROOM: Size = { width: 0, height: 0 }

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
  const canvas = useRef<HTMLDivElement>(null)
  const room = useRoom(canvas)
  const [view, setView] = useState<GraphView>(OPENING_VIEW)

  const frame: Frame = useMemo(
    () => ({ drawing: { width: layout.width, height: layout.height }, room }),
    [layout.width, layout.height, room]
  )
  const { panning, pressing } = useCanvasGestures(canvas, frame, setView)
  const placement = placementOf(view, frame)
  const live = view.kind === 'fit'

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
            className={`pill${live ? ' on' : ''}`}
            onClick={() => setView(OPENING_VIEW)}
            aria-pressed={live}
          >
            fit
          </button>
          {/* Its name is its reading: the zoom is the one thing this pill has
              to say, and a fixed label would hide it. */}
          <button
            className="pill pct"
            title="Set zoom to 100%"
            onClick={() =>
              setView((held) =>
                zoomedTo(held, frame, { x: room.width / 2, y: room.height / 2 }, 1)
              )
            }
          >
            {Math.round(placement.scale * 100)}%
          </button>
          <button className="pill" onClick={onToggleFullScreen}>
            {fullScreen ? '⤢ exit full screen' : '⤢ full screen'}
          </button>
        </span>
      </div>

      <div className={`gcanvas${panning ? ' dragging' : ''}`} ref={canvas}>
        <div
          className="cstage"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${placement.at.x}px, ${placement.at.y}px) scale(${placement.scale})`
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
                // Tabbing to a card off the visible area brings it into view,
                // the way the scrolling pane used to for free. The box comes
                // from the layout, never from the DOM, so it cannot disagree
                // with what is drawn. Not under a press, though: a browser
                // focuses a button on mousedown, and a reveal there would
                // jump the view before the click selects or the drag pans.
                onFocus={() => {
                  if (pressing()) return
                  setView((held) =>
                    revealed(held, frame, {
                      x: card.x,
                      y: card.y,
                      width: layout.cardWidth,
                      height: layout.cardHeight
                    })
                  )
                }}
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

/**
 * The room the canvas has, which is what a live fit measures itself against.
 * Re-read after every commit — full screen, the splitter and a node arriving
 * all re-render this tree — and by a ResizeObserver for the resize that
 * re-renders nothing. Stored only when the numbers change, so measuring
 * cannot loop.
 */
function useRoom(canvas: React.RefObject<HTMLElement | null>): Size {
  const [room, setRoom] = useState<Size>(NO_ROOM)

  useLayoutEffect(() => {
    const measure = (): void => setRoom((held) => boxOf(canvas.current, held))
    measure()
  })

  useEffect(() => {
    const element = canvas.current
    if (element === null) return
    const measure = (): void => setRoom((held) => boxOf(canvas.current, held))
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [canvas])

  return room
}

/** The element's box, or the size already held when the numbers have not moved. */
function boxOf(element: HTMLElement | null, held: Size): Size {
  if (element === null) return held
  const box = element.getBoundingClientRect()
  return held.width === box.width && held.height === box.height
    ? held
    : { width: box.width, height: box.height }
}

/** A press in flight, and whether it has become a pan. */
interface Press {
  readonly from: Point
  at: Point
  panning: boolean
}

/**
 * Pointer, wheel and double-click on the canvas, turned into view transitions
 * and at most one selection per press. The wheel is listened for natively with
 * `{ passive: false }`: React registers wheel passively at the root, where
 * `preventDefault` is a no-op, and not scrolling the run view is the whole
 * promise. Pointer move and up go to the window, so a drag that leaves the
 * pane keeps working.
 */
function useCanvasGestures(
  canvas: React.RefObject<HTMLDivElement | null>,
  frame: Frame,
  setView: React.Dispatch<React.SetStateAction<GraphView>>
): { readonly panning: boolean; readonly pressing: () => boolean } {
  const [panning, setPanning] = useState(false)
  const held = useRef(frame)
  useLayoutEffect(() => {
    held.current = frame
  })
  // Read by the cards, which must tell a focus the user asked for from the
  // one a press brings with it.
  const press = useRef<Press | undefined>(undefined)

  useEffect(() => {
    const element = canvas.current
    if (element === null) return
    // The click a pan ends with belongs to the pan, not to the card under the
    // pointer; it is swallowed once, and the next press clears the debt.
    let swallow = false

    const pointIn = (event: { clientX: number; clientY: number }): Point => {
      const box = element.getBoundingClientRect()
      return { x: event.clientX - box.left, y: event.clientY - box.top }
    }

    const onWheel = (event: WheelEvent): void => {
      // Nothing a gesture over the canvas does scrolls the run view, the rail
      // or the window, and nothing selects text.
      event.preventDefault()
      const intent = wheelIntent(event)
      if (intent.kind === 'pan') {
        setView((view) => panned(view, held.current, intent.by))
        return
      }
      const about = pointIn(event)
      setView((view) => zoomedBy(view, held.current, about, intent.factor))
    }

    const onMove = (event: PointerEvent): void => {
      const going = press.current
      if (going === undefined) return
      const at = { x: event.clientX, y: event.clientY }
      if (!going.panning && !movedFar(going.from, at)) return
      if (!going.panning) {
        going.panning = true
        setPanning(true)
      }
      const by = { x: at.x - going.at.x, y: at.y - going.at.y }
      going.at = at
      setView((view) => panned(view, held.current, by))
    }

    const onUp = (event: PointerEvent): void => {
      const going = press.current
      press.current = undefined
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (going?.panning !== true) return
      // Only a release over the canvas raises its click here: let go over the
      // detail column and the browser fires the click on an ancestor, where
      // an armed swallow would outlive the pan and eat the next activation —
      // the Enter on a focused card — instead.
      const box = element.getBoundingClientRect()
      swallow =
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom
      setPanning(false)
    }

    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0) return
      swallow = false
      const from = { x: event.clientX, y: event.clientY }
      press.current = { from, at: from, panning: false }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    }

    const onClick = (event: MouseEvent): void => {
      if (!swallow) return
      swallow = false
      event.stopPropagation()
      event.preventDefault()
    }

    const onDoubleClick = (event: MouseEvent): void => {
      // On a card a double-click is two selections and nothing more.
      if ((event.target as Element | null)?.closest('.nd') !== null) return
      const about = pointIn(event)
      setView((view) => zoomedBy(view, held.current, about, DOUBLE_CLICK_STEP))
    }

    element.addEventListener('wheel', onWheel, { passive: false })
    element.addEventListener('pointerdown', onDown)
    element.addEventListener('click', onClick, true)
    element.addEventListener('dblclick', onDoubleClick)
    return () => {
      element.removeEventListener('wheel', onWheel)
      element.removeEventListener('pointerdown', onDown)
      element.removeEventListener('click', onClick, true)
      element.removeEventListener('dblclick', onDoubleClick)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [canvas, setView])

  return { panning, pressing: () => press.current !== undefined }
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
