// @vitest-environment node
//
// The view the graph pane is looked at through: what fit resolves to, what a
// gesture does to it, and what it takes to end a live fit. A value and its
// transitions, so none of it needs a window — and the one rule that matters
// most is structural: while fit is live the view holds no numbers, so a
// drawing that grew or a pane that changed size is refitted by the next read
// rather than by an event that might not fire.
import { describe, expect, it } from 'vitest'
import {
  DOUBLE_CLICK_STEP,
  FIT_MARGIN,
  MAX_SCALE,
  MIN_SCALE,
  movedFar,
  OPENING_VIEW,
  panned,
  placementOf,
  revealed,
  wheelIntent,
  zoomedBy,
  zoomedTo,
  type Frame,
  type GraphView
} from './canvas'

const frameOf = (drawing: [number, number], room: [number, number]): Frame => ({
  drawing: { width: drawing[0], height: drawing[1] },
  room: { width: room[0], height: room[1] }
})

/** Where a point of the drawing lands in the pane, which is what a pivot holds. */
const shownAt = (view: GraphView, frame: Frame, point: { x: number; y: number }) => {
  const placement = placementOf(view, frame)
  return {
    x: placement.at.x + point.x * placement.scale,
    y: placement.at.y + point.y * placement.scale
  }
}

describe('fit', () => {
  it('shows a small drawing whole and centred, and never blows it up', () => {
    const placement = placementOf(OPENING_VIEW, frameOf([100, 100], [800, 600]))

    expect(placement.scale).toBe(1)
    expect(placement.at).toEqual({ x: 350, y: 250 })
  })

  it('shrinks a big drawing to the tighter axis, margin on all four sides', () => {
    const frame = frameOf([2000, 1000], [800, 600])
    const placement = placementOf(OPENING_VIEW, frame)

    expect(placement.scale).toBeCloseTo((800 - 2 * FIT_MARGIN) / 2000, 10)
    // Centred on both axes, with the margin kept on the tighter one.
    expect(placement.at.x).toBeCloseTo(FIT_MARGIN, 10)
    expect(placement.at.y).toBeCloseTo((600 - 1000 * placement.scale) / 2, 10)
  })

  it('floors at 25% and anchors the roots at the top when even that overflows', () => {
    const placement = placementOf(OPENING_VIEW, frameOf([10_000, 10_000], [800, 600]))

    expect(placement.scale).toBe(MIN_SCALE)
    // Centred horizontally, so the spine stays in the middle of the pane.
    expect(placement.at.x).toBe((800 - 10_000 * MIN_SCALE) / 2)
    // And the top of the drawing at the margin, so the roots are what is seen.
    expect(placement.at.y).toBe(FIT_MARGIN)
  })

  it('reads a valid percent before anything has measured the pane', () => {
    const placement = placementOf(OPENING_VIEW, frameOf([1000, 1000], [0, 0]))

    expect(placement.scale).toBe(1)
    expect(placement.at).toEqual({ x: 0, y: 0 })
  })

  it('refits itself when the drawing grows or the room changes', () => {
    const small = placementOf(OPENING_VIEW, frameOf([400, 400], [800, 600]))
    const grown = placementOf(OPENING_VIEW, frameOf([400, 900], [800, 600]))
    const narrowed = placementOf(OPENING_VIEW, frameOf([400, 400], [500, 600]))

    // The same view, and the picture is whole and centred in all three.
    expect(grown.scale).toBeLessThan(small.scale)
    expect(grown.at.y).toBeCloseTo((600 - 900 * grown.scale) / 2, 10)
    expect(narrowed.at.x).toBeCloseTo((500 - 400 * narrowed.scale) / 2, 10)
    expect(narrowed.scale).toBe(small.scale)
  })

  it('ignores a nudge on an axis that already shows whole', () => {
    const frame = frameOf([400, 400], [800, 600])
    const nudged: GraphView = { kind: 'fit', shift: { x: 90, y: -120 } }

    expect(placementOf(nudged, frame)).toEqual(placementOf(OPENING_VIEW, frame))
  })
})

describe('zoom', () => {
  const frame = frameOf([1000, 1000], [800, 600])

  it('holds the point under the pointer while it scales', () => {
    const about = { x: 300, y: 200 }
    const before = placementOf(OPENING_VIEW, frame)
    const zoomed = zoomedBy(OPENING_VIEW, frame, about, 2)
    const after = placementOf(zoomed, frame)

    expect(after.scale).toBeCloseTo(before.scale * 2, 10)
    // The point of the drawing under the pointer is where it was.
    const held = { x: (about.x - before.at.x) / before.scale, y: (about.y - before.at.y) / before.scale }
    expect(shownAt(zoomed, frame, held).x).toBeCloseTo(about.x, 8)
    expect(shownAt(zoomed, frame, held).y).toBeCloseTo(about.y, 8)
  })

  it('clamps to the range, and a gesture at the limit moves nothing at all', () => {
    const about = { x: 400, y: 300 }
    const far = zoomedBy(OPENING_VIEW, frame, about, 100)
    const near = zoomedBy(OPENING_VIEW, frame, about, 0.001)

    expect(placementOf(far, frame).scale).toBe(MAX_SCALE)
    expect(placementOf(near, frame).scale).toBe(MIN_SCALE)
    // At a limit, asking for more leaves the placement identical.
    expect(placementOf(zoomedBy(far, frame, { x: 100, y: 100 }, 4), frame)).toEqual(
      placementOf(far, frame)
    )
    expect(placementOf(zoomedBy(near, frame, { x: 100, y: 100 }, 0.5), frame)).toEqual(
      placementOf(near, frame)
    )
  })

  it('snaps to exactly 100% about a point, which is the percent pill', () => {
    const centre = { x: 400, y: 300 }
    const zoomed = zoomedTo(zoomedBy(OPENING_VIEW, frame, centre, 2), frame, centre, 1)
    const placement = placementOf(zoomed, frame)

    expect(placement.scale).toBe(1)
    expect(Math.round(placement.scale * 100)).toBe(100)
    // About the point given: what was in the middle of the pane still is.
    expect(placement.at.x).toBeCloseTo(centre.x - 1000 / 2, 8)
  })

  it('takes a pinch and a ⌘ or ctrl wheel as one thing, and a plain wheel as a pan', () => {
    expect(wheelIntent({ deltaX: 0, deltaY: -10, ctrlKey: true, metaKey: false }).kind).toBe('zoom')
    expect(wheelIntent({ deltaX: 0, deltaY: -10, ctrlKey: false, metaKey: true }).kind).toBe('zoom')
    // Away from the user zooms in, towards them zooms out.
    const inward = wheelIntent({ deltaX: 0, deltaY: -10, ctrlKey: true, metaKey: false })
    const outward = wheelIntent({ deltaX: 0, deltaY: 10, ctrlKey: true, metaKey: false })
    expect(inward.kind === 'zoom' && inward.factor).toBeGreaterThan(1)
    expect(outward.kind === 'zoom' && outward.factor).toBeLessThan(1)

    // A plain wheel or two-finger scroll pans, on both axes, the way a
    // scrolled page's content moves.
    const panning = wheelIntent({ deltaX: 12, deltaY: 30, ctrlKey: false, metaKey: false })
    expect(panning).toEqual({ kind: 'pan', by: { x: -12, y: -30 } })
  })
})

describe('what ends a live fit', () => {
  const frame = frameOf([1000, 1000], [800, 600])

  it('is every gesture, and nothing else', () => {
    expect(panned(OPENING_VIEW, frame, { x: 10, y: 0 }).kind).toBe('held')
    expect(zoomedBy(OPENING_VIEW, frame, { x: 0, y: 0 }, DOUBLE_CLICK_STEP).kind).toBe('held')
    expect(zoomedTo(OPENING_VIEW, frame, { x: 0, y: 0 }, 1).kind).toBe('held')
    // A move the system makes on the user's behalf is not the user's gesture.
    expect(revealed(OPENING_VIEW, frame, { x: 0, y: 0, width: 10, height: 10 }).kind).toBe('fit')
    // And the fit pill puts it back from anywhere.
    expect(OPENING_VIEW).toEqual({ kind: 'fit', shift: { x: 0, y: 0 } })
  })

  it('moves the drawing one for one with a pan, and holds it there', () => {
    const before = placementOf(OPENING_VIEW, frame)
    const view = panned(OPENING_VIEW, frame, { x: -40, y: 25 })
    const after = placementOf(view, frame)

    expect(after.scale).toBe(before.scale)
    expect(after.at).toEqual({ x: before.at.x - 40, y: before.at.y + 25 })
    // Held: the drawing growing moves nothing now.
    expect(placementOf(view, frameOf([1000, 4000], [800, 600]))).toEqual(after)
  })

  it('is not a press that never moved far enough to be a pan', () => {
    expect(movedFar({ x: 10, y: 10 }, { x: 12, y: 12 })).toBe(false)
    expect(movedFar({ x: 10, y: 10 }, { x: 10, y: 13.9 })).toBe(false)
    expect(movedFar({ x: 10, y: 10 }, { x: 14, y: 10 })).toBe(true)
    expect(movedFar({ x: 10, y: 10 }, { x: 13, y: 13 })).toBe(true)
  })
})

describe('keeping a focused card in view', () => {
  const frame = frameOf([10_000, 10_000], [400, 400])
  const card = (x: number, y: number) => ({ x, y, width: 200, height: 60 })

  it('leaves the view exactly as it is when the card is already whole', () => {
    const view = zoomedTo(OPENING_VIEW, frame, { x: 0, y: 0 }, MIN_SCALE)
    const inside = { x: -placementOf(view, frame).at.x / MIN_SCALE + 40, y: 40 }

    expect(revealed(view, frame, card(inside.x, inside.y))).toBe(view)
  })

  it('makes the smallest move that brings the card whole into the pane', () => {
    const view = { kind: 'held', scale: 1, at: { x: 0, y: 0 } } as const
    // Off the right edge and below: the card's far corner lands on the pane's.
    const moved = revealed(view, frame, card(500, 700))
    const placement = placementOf(moved, frame)

    expect(placement.scale).toBe(1)
    expect(placement.at.x + 500 + 200).toBeCloseTo(400, 8)
    expect(placement.at.y + 700 + 60).toBeCloseTo(400, 8)
  })

  it('shows the start of a card too big for the pane', () => {
    const view = { kind: 'held', scale: 1, at: { x: 0, y: 0 } } as const
    const moved = revealed(view, frame, { x: 900, y: 900, width: 900, height: 900 })
    const placement = placementOf(moved, frame)

    expect(placement.at.x + 900).toBeCloseTo(0, 8)
    expect(placement.at.y + 900).toBeCloseTo(0, 8)
  })

  it('keeps a live fit live, nudging the fitted placement instead', () => {
    // A floored fit that cannot show everything: the roots are anchored, so a
    // card further down needs the view to move to be seen at all.
    const moved = revealed(OPENING_VIEW, frame, card(0, 9000))

    expect(moved.kind).toBe('fit')
    const placement = placementOf(moved, frame)
    expect(placement.scale).toBe(MIN_SCALE)
    expect(placement.at.y + 9000 * MIN_SCALE + 60 * MIN_SCALE).toBeCloseTo(400, 8)
    // And never far enough to pull the drawing's own edge into the pane.
    expect(placementOf({ kind: 'fit', shift: { x: 0, y: -100_000 } }, frame).at.y).toBe(
      400 - FIT_MARGIN - 10_000 * MIN_SCALE
    )
  })
})
