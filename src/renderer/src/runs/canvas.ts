// The run graph's view: what the user is looking at, and what a gesture does
// to it. A value with its transitions and nothing else — no DOM, no React, no
// run record — so every rule here is provable without a window.
//
// Fit carries no numbers at all. While fit is live the placement is a function
// of the drawing and the room it is shown in, so a refit is what the next
// render already does: a node arriving, the splitter moving, the window
// resizing and full screen all change the frame, and the same view resolves
// against the new one. A gesture holds the view by turning it into the numbers
// it was showing.

export interface Size {
  readonly width: number
  readonly height: number
}

export interface Point {
  readonly x: number
  readonly y: number
}

export interface Box extends Point, Size {}

/** The drawing and the room it is shown in: what a view resolves against. */
export interface Frame {
  /** The layout's extent, in layout units. */
  readonly drawing: Size
  /** The canvas element's box, in CSS pixels. Zero until it is measured. */
  readonly room: Size
}

/** What the user is looking at. */
export type GraphView =
  | {
      readonly kind: 'fit'
      /**
       * How far the fitted placement is nudged to keep a focused card
       * visible when a floored fit cannot show everything. Zero for any fit
       * that shows the whole drawing, and clamped by `placementOf`.
       */
      readonly shift: Point
    }
  | {
      readonly kind: 'held'
      /** Always within [MIN_SCALE, MAX_SCALE]. */
      readonly scale: number
      /** The stage's translation in the pane, in CSS pixels. */
      readonly at: Point
    }

/** What the stage is actually drawn with. */
export interface Placement {
  readonly scale: number
  readonly at: Point
}

/** Zoom limits, inclusive. */
export const MIN_SCALE = 0.25
export const MAX_SCALE = 2.5

/** The room fit keeps between the drawing and each edge of the pane. */
export const FIT_MARGIN = 24

/** What one double-click on empty canvas multiplies the scale by. */
export const DOUBLE_CLICK_STEP = 1.5

/** Under this much pointer movement, a press is a click and not a pan. */
export const CLICK_SLOP = 4

/** How fast a wheel or a pinch zooms, per pixel of travel. */
const ZOOM_RATE = 0.01

const ORIGIN: Point = { x: 0, y: 0 }

/** Every graph opens here, and the fit pill returns here. */
export const OPENING_VIEW: GraphView = { kind: 'fit', shift: ORIGIN }

/**
 * The numbers a view resolves to. Fit is the largest scale not above 1 at
 * which the drawing plus `FIT_MARGIN` on all four sides fits both axes,
 * floored at `MIN_SCALE`; the drawing is centred horizontally, and centred
 * vertically unless the floored fit overflows, in which case its top is
 * anchored at the margin. An unmeasured room resolves to scale 1 at the
 * pane's origin, so a pane nothing has measured still reads a valid percent.
 */
export function placementOf(view: GraphView, frame: Frame): Placement {
  if (view.kind === 'held') return { scale: clampScale(view.scale), at: view.at }
  if (!measured(frame)) return { scale: 1, at: ORIGIN }

  const { drawing, room } = frame
  const scale = clampScale(
    Math.min(
      1,
      (room.width - 2 * FIT_MARGIN) / Math.max(1, drawing.width),
      (room.height - 2 * FIT_MARGIN) / Math.max(1, drawing.height)
    )
  )
  const shown = { width: drawing.width * scale, height: drawing.height * scale }
  // Centred on an axis that fits; on one a floored fit cannot show, the
  // roots are what the user sees, so the top is anchored at the margin.
  const x = (room.width - shown.width) / 2
  const y =
    shown.height > room.height - 2 * FIT_MARGIN ? FIT_MARGIN : (room.height - shown.height) / 2
  return {
    scale,
    at: {
      x: nudged(x, view.shift.x, shown.width, room.width),
      y: nudged(y, view.shift.y, shown.height, room.height)
    }
  }
}

/** Translates by `by`, in pane pixels, and holds the view. */
export function panned(view: GraphView, frame: Frame, by: Point): GraphView {
  const now = placementOf(view, frame)
  return { kind: 'held', scale: now.scale, at: { x: now.at.x + by.x, y: now.at.y + by.y } }
}

/**
 * Multiplies the scale about a point in the pane, clamped, keeping the point
 * of the drawing under `about` where it was. At a limit, a gesture asking for
 * more leaves the placement identical.
 */
export function zoomedBy(
  view: GraphView,
  frame: Frame,
  about: Point,
  factor: number
): GraphView {
  const now = placementOf(view, frame)
  return heldAt(now, about, clampScale(now.scale * factor))
}

/** Sets the scale exactly, about a point in the pane: the percent pill's snap. */
export function zoomedTo(
  view: GraphView,
  frame: Frame,
  about: Point,
  scale: number
): GraphView {
  const now = placementOf(view, frame)
  return heldAt(now, about, clampScale(scale))
}

/**
 * The smallest move that brings a card fully inside the pane, or the view
 * unchanged when it already is. Never zooms, and never ends live fit: a fit
 * view comes back as a fit view with its shift adjusted, because a system
 * move is not the user's gesture.
 */
export function revealed(view: GraphView, frame: Frame, card: Box): GraphView {
  if (!measured(frame)) return view
  const now = placementOf(view, frame)
  const by = {
    x: reveal(now.at.x + card.x * now.scale, card.width * now.scale, frame.room.width),
    y: reveal(now.at.y + card.y * now.scale, card.height * now.scale, frame.room.height)
  }
  if (by.x === 0 && by.y === 0) return view
  if (view.kind === 'fit') {
    return { kind: 'fit', shift: { x: view.shift.x + by.x, y: view.shift.y + by.y } }
  }
  return { kind: 'held', scale: now.scale, at: { x: now.at.x + by.x, y: now.at.y + by.y } }
}

/** What one wheel event over the canvas asks for. */
export type WheelIntent =
  | { readonly kind: 'pan'; readonly by: Point }
  | { readonly kind: 'zoom'; readonly factor: number }

/**
 * Chromium delivers a touchpad pinch as a ctrl-modified wheel, so the pinch
 * and ⌘/ctrl+wheel arrive here as one thing and leave as one intent; a plain
 * wheel or two-finger scroll pans, in the direction a scrolled page's content
 * would move.
 */
export function wheelIntent(
  wheel: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'ctrlKey' | 'metaKey'>
): WheelIntent {
  if (wheel.ctrlKey || wheel.metaKey) {
    return { kind: 'zoom', factor: Math.exp(-wheel.deltaY * ZOOM_RATE) }
  }
  return { kind: 'pan', by: { x: -wheel.deltaX, y: -wheel.deltaY } }
}

/** Whether a press has moved far enough to be a pan rather than a click. */
export function movedFar(from: Point, to: Point): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= CLICK_SLOP
}

/** A pane with no measurement yet fits nothing and reveals nothing. */
function measured(frame: Frame): boolean {
  return frame.room.width > 0 && frame.room.height > 0
}

function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale))
}

/** The zoom, held, about a point the drawing must not move under. */
function heldAt(now: Placement, about: Point, scale: number): GraphView {
  const step = scale / now.scale
  return {
    kind: 'held',
    scale,
    at: {
      x: about.x - (about.x - now.at.x) * step,
      y: about.y - (about.y - now.at.y) * step
    }
  }
}

/**
 * A fit view's shift, applied and clamped: nothing on an axis the drawing
 * already shows whole, and never far enough to pull the drawing's edge inside
 * the margin on an axis it overflows.
 */
function nudged(at: number, shift: number, shown: number, room: number): number {
  if (shown <= room - 2 * FIT_MARGIN) return at
  return Math.max(room - FIT_MARGIN - shown, Math.min(FIT_MARGIN, at + shift))
}

/** How far one axis has to move to bring a span fully inside the room. */
function reveal(start: number, span: number, room: number): number {
  if (span >= room) return -start
  if (start < 0) return -start
  if (start + span > room) return room - (start + span)
  return 0
}
