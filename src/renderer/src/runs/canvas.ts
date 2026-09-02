export interface Size {
  readonly width: number
  readonly height: number
}

export interface Point {
  readonly x: number
  readonly y: number
}

export interface Box extends Point, Size {}

export interface Frame {
  readonly drawing: Size
  readonly room: Size
}

export type GraphView =
  | {
      readonly kind: 'fit'
      readonly shift: Point
    }
  | {
      readonly kind: 'held'
      readonly scale: number
      readonly at: Point
    }

export interface Placement {
  readonly scale: number
  readonly at: Point
}

export const MIN_SCALE = 0.25
export const MAX_SCALE = 2.5

export const FIT_MARGIN = 24

export const DOUBLE_CLICK_STEP = 1.5

export const CLICK_SLOP = 4

const ZOOM_RATE = 0.01

const ORIGIN: Point = { x: 0, y: 0 }

export const OPENING_VIEW: GraphView = { kind: 'fit', shift: ORIGIN }

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

export function panned(view: GraphView, frame: Frame, by: Point): GraphView {
  const now = placementOf(view, frame)
  return { kind: 'held', scale: now.scale, at: { x: now.at.x + by.x, y: now.at.y + by.y } }
}

export function zoomedBy(
  view: GraphView,
  frame: Frame,
  about: Point,
  factor: number
): GraphView {
  const now = placementOf(view, frame)
  return heldAt(now, about, clampScale(now.scale * factor))
}

export function zoomedTo(
  view: GraphView,
  frame: Frame,
  about: Point,
  scale: number
): GraphView {
  const now = placementOf(view, frame)
  return heldAt(now, about, clampScale(scale))
}

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

export type WheelIntent =
  | { readonly kind: 'pan'; readonly by: Point }
  | { readonly kind: 'zoom'; readonly factor: number }

export function wheelIntent(
  wheel: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'ctrlKey' | 'metaKey'>
): WheelIntent {
  if (wheel.ctrlKey || wheel.metaKey) {
    return { kind: 'zoom', factor: Math.exp(-wheel.deltaY * ZOOM_RATE) }
  }
  return { kind: 'pan', by: { x: -wheel.deltaX, y: -wheel.deltaY } }
}

export function movedFar(from: Point, to: Point): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= CLICK_SLOP
}

function measured(frame: Frame): boolean {
  return frame.room.width > 0 && frame.room.height > 0
}

function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale))
}

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

function nudged(at: number, shift: number, shown: number, room: number): number {
  if (shown <= room - 2 * FIT_MARGIN) return at
  return Math.max(room - FIT_MARGIN - shown, Math.min(FIT_MARGIN, at + shift))
}

function reveal(start: number, span: number, room: number): number {
  if (span >= room) return -start
  if (start < 0) return -start
  if (start + span > room) return room - (start + span)
  return 0
}
