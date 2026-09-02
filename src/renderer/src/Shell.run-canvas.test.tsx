// @vitest-environment jsdom
//
// The graph pane as a canvas: it opens fit and centred, the user pans and
// zooms it with the pointer, and the two pills say where the view stands and
// put it back. Driven through the same scripted run seam as the rest of the
// run surfaces — the record is the whole input, and every assertion here is
// something a person could see.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import type { RunNode, RunRecord } from '../../shared/workflows/run'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort } from './testing/scripted-port'
import { createScriptedWorkflowRuns } from './testing/scripted-workflow-runs'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { settled } from './testing/settled'

const SNAPSHOT: ShellSnapshot = {
  workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
  activeWorkspaceId: 'w1',
  activeSessionId: 's1',
  sessions: [
    {
      id: 's1',
      workspaceId: 'w1',
      createdAt: '2026-08-21T10:00:00.000Z',
      title: 'the run canvas',
      working: false,
      fresh: false
    }
  ]
}

function nodeOf(id: string, parents: string[], overrides: Partial<RunNode> = {}): RunNode {
  return {
    id,
    status: 'complete',
    parents,
    model: 'anthropic/claude-fable-5:high',
    reads: [],
    artifacts: [],
    startedAt: '2026-08-21T10:00:00.000Z',
    endedAt: '2026-08-21T10:12:00.000Z',
    ...overrides
  }
}

function runOf(nodes?: readonly RunNode[]): RunRecord {
  return {
    id: 'en42',
    workflow: 'build',
    status: 'running',
    workspacePath: '/repos/crucible',
    workspaceName: 'crucible',
    sessionId: 's1',
    branch: 'crucible/run-en42',
    inputs: {},
    nodes: nodes ?? [
      nodeOf('planner', []),
      nodeOf('builder', ['planner']),
      nodeOf('review-1', ['builder']),
      nodeOf('fixer-1', ['review-1']),
      nodeOf('review-2', ['fixer-1']),
      nodeOf('gate-alignment-1', ['review-2'])
    ],
    createdAt: '2026-08-21T10:00:00.000Z',
    startedAt: '2026-08-21T10:00:00.000Z'
  }
}

function mount(runs: readonly RunRecord[]) {
  const port = createScriptedPort(SNAPSHOT)
  const workflowRuns = createScriptedWorkflowRuns(runs)
  const view = render(
    <Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
      workflowRuns={workflowRuns}
    />
  )
  return { port, workflowRuns, view }
}

/** ⌘R, then Open run: the one door every run has. */
async function openRun(runs: readonly RunRecord[] = [runOf()]) {
  const rig = mount(runs)
  await act(settled)
  await act(async () => {
    fireEvent.keyDown(document, { key: 'r', metaKey: true })
    await settled()
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Open run' }))
    await settled()
  })
  return rig
}

const canvas = (): HTMLElement => document.querySelector('.gcanvas') as HTMLElement

const stage = (): HTMLElement => document.querySelector('.cstage') as HTMLElement

const cardFor = (id: string): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>('.nd')].find(
    (card) => card.querySelector('.nm')?.textContent === id
  )
  if (found === undefined) throw new Error(`no card for ${id}`)
  return found
}

/** What the pane is drawn with, read back off the one transform. */
function view(): {
  x: number
  y: number
  scale: number
  width: number
  height: number
} {
  const held = stage()
  const read = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(
    held.style.transform
  )
  if (read === null) throw new Error(`unreadable transform: ${held.style.transform}`)
  return {
    x: Number(read[1]),
    y: Number(read[2]),
    scale: Number(read[3]),
    width: Number.parseFloat(held.style.width),
    height: Number.parseFloat(held.style.height)
  }
}

/** A canvas of a known size, since jsdom lays nothing out on its own. */
async function sizeCanvas(width: number, height: number): Promise<void> {
  const element = canvas()
  element.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      x: 0,
      y: 0
    }) as DOMRect
  await act(async () => {
    window.dispatchEvent(new Event('resize'))
    await settled()
  })
}

const pill = (name: string | RegExp): HTMLElement => screen.getByRole('button', { name })

const percentPill = (): HTMLElement => document.querySelector('.ghead .pill.pct') as HTMLElement

const detailHeader = (): string => document.querySelector('.detail .dhead .n')?.textContent ?? ''

/** One wheel over the canvas, reporting whether the pane took the event. */
function wheel(over: HTMLElement, init: WheelEventInit): boolean {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
  act(() => {
    over.dispatchEvent(event)
  })
  return event.defaultPrevented
}

/** A press, a move and a release, as a browser delivers them. */
async function press(
  on: HTMLElement,
  from: { x: number; y: number },
  to: { x: number; y: number }
): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(on, { button: 0, clientX: from.x, clientY: from.y })
    fireEvent.pointerMove(window, { clientX: to.x, clientY: to.y })
    await settled()
  })
  await act(async () => {
    fireEvent.pointerUp(window, { clientX: to.x, clientY: to.y })
    fireEvent.click(on, { clientX: to.x, clientY: to.y })
    await settled()
  })
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('the pane is a canvas', () => {
  it('draws the whole graph on one stage under one canvas, and never scrolls', async () => {
    await openRun()
    await sizeCanvas(600, 500)

    // One drawing area, one stage, and nothing left of the scroller it was.
    expect(document.querySelectorAll('.gcanvas')).toHaveLength(1)
    expect(document.querySelectorAll('.cstage')).toHaveLength(1)
    expect(document.querySelector('.gscroll')).toBeNull()
    expect(canvas().contains(stage())).toBe(true)

    // Cards and edges are one drawing: they move and scale together, under a
    // single transform on the stage.
    const drawn = [...stage().children].map((child) => child.tagName.toLowerCase())
    expect(new Set(drawn)).toEqual(new Set(['svg', 'button']))
    expect(drawn.filter((tag) => tag === 'button')).toHaveLength(6)
    const inSvg = [...(stage().querySelector('svg') as SVGElement).children].map((child) =>
      child.tagName.toLowerCase()
    )
    expect(new Set(inSvg)).toEqual(new Set(['path']))
  })

  it('keeps the header out of the drawing, with its three controls in order', async () => {
    await openRun()
    await sizeCanvas(600, 500)
    const head = document.querySelector('.ghead') as HTMLElement

    expect(canvas().contains(head)).toBe(false)
    expect([...head.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'fit',
      '100%',
      '⤢ full screen'
    ])
  })

  it('carries no text, no title and no click on any edge', async () => {
    await openRun()
    await sizeCanvas(600, 500)
    const svg = stage().querySelector('svg') as SVGElement

    expect(svg.querySelectorAll('text, title')).toHaveLength(0)
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    const path = svg.querySelector('path') as SVGPathElement
    await act(async () => {
      fireEvent.click(path)
      await settled()
    })
    // The frontier is what the view opens on; clicking a line changes nothing.
    expect(detailHeader()).toBe('gate-alignment-1')
  })
})

describe('fit, and when it stays live', () => {
  it('opens fit, centred and lit, and refits as the pane and the run change', async () => {
    const { workflowRuns } = await openRun()
    await sizeCanvas(600, 500)

    expect(pill('fit')).toHaveAttribute('aria-pressed', 'true')
    const opened = view()
    expect(opened.scale).toBeLessThanOrEqual(1)
    expect(opened.scale).toBeGreaterThanOrEqual(0.25)
    // Centred: the room left of the drawing is the room right of it.
    expect(2 * opened.x + opened.width * opened.scale).toBeCloseTo(600, 6)
    expect(2 * opened.y + opened.height * opened.scale).toBeCloseTo(500, 6)

    // A narrower pane refits by itself, with nobody touching anything.
    await sizeCanvas(300, 300)
    const tighter = view()
    expect(tighter.scale).toBeLessThan(opened.scale)
    expect(2 * tighter.x + tighter.width * tighter.scale).toBeCloseTo(300, 6)

    // And so does a run that grew a node.
    await act(async () => {
      const grown = runOf()
      workflowRuns.setRuns([
        { ...grown, nodes: [...grown.nodes, nodeOf('gate-comments-1', ['gate-alignment-1'])] }
      ])
      await settled()
    })
    const wider = view()
    expect(wider.height).toBeGreaterThan(tighter.height)
    expect(wider.scale).toBeLessThan(tighter.scale)
    expect(pill('fit')).toHaveAttribute('aria-pressed', 'true')
  })

  it('holds the view from the first gesture, and the fit pill takes it back', async () => {
    await openRun()
    await sizeCanvas(600, 500)
    const opened = view()

    expect(wheel(canvas(), { deltaX: 0, deltaY: 40 })).toBe(true)
    expect(pill('fit')).toHaveAttribute('aria-pressed', 'false')
    expect(view().y).toBeCloseTo(opened.y - 40, 6)

    // Held: the pane changing size now moves nothing.
    await sizeCanvas(400, 400)
    expect(view()).toEqual({ ...opened, y: opened.y - 40 })

    // The fit pill refits and lights again, from any view.
    await act(async () => {
      fireEvent.click(pill('fit'))
      await settled()
    })
    expect(pill('fit')).toHaveAttribute('aria-pressed', 'true')
    expect(2 * view().x + view().width * view().scale).toBeCloseTo(400, 6)
  })

  it('is where every run opens, whatever the last one was left at', async () => {
    const { view: rendered } = await openRun()
    await sizeCanvas(600, 500)
    expect(wheel(canvas(), { deltaX: 0, deltaY: 120 })).toBe(true)
    expect(pill('fit')).toHaveAttribute('aria-pressed', 'false')

    rendered.unmount()
    await openRun()
    await sizeCanvas(600, 500)
    expect(pill('fit')).toHaveAttribute('aria-pressed', 'true')
    expect(2 * view().x + view().width * view().scale).toBeCloseTo(600, 6)
  })

  it('draws an empty record as an empty canvas', async () => {
    await openRun([runOf([])])
    await sizeCanvas(600, 500)

    expect(document.querySelector('.ghead .c')?.textContent).toBe('0 nodes')
    expect(document.querySelectorAll('.nd')).toHaveLength(0)
    expect(pill('fit')).toHaveAttribute('aria-pressed', 'true')
    expect(percentPill().textContent).toMatch(/^\d+%$/)
  })
})

describe('zoom', () => {
  it('reads the zoom on the percent pill and snaps back to 100%', async () => {
    await openRun()
    await sizeCanvas(300, 300)

    const fitted = view()
    expect(percentPill().textContent).toBe(`${Math.round(fitted.scale * 100)}%`)
    expect(fitted.scale).toBeLessThan(1)

    await act(async () => {
      fireEvent.click(percentPill())
      await settled()
    })
    expect(view().scale).toBe(1)
    expect(percentPill().textContent).toBe('100%')
    // Snapping is a zoom, so the fit pill goes dark with it.
    expect(pill('fit')).toHaveAttribute('aria-pressed', 'false')
    // About the centre of the pane: what was in the middle still is.
    const snapped = view()
    expect(snapped.x + snapped.width / 2).toBeCloseTo(
      fitted.x + (fitted.width * fitted.scale) / 2,
      6
    )
  })

  it('zooms about the pointer on ⌘ + wheel, and stops at the limits', async () => {
    await openRun()
    await sizeCanvas(600, 500)
    const before = view()
    const under = { x: (200 - before.x) / before.scale, y: (150 - before.y) / before.scale }

    expect(wheel(canvas(), { deltaY: -50, metaKey: true, clientX: 200, clientY: 150 })).toBe(true)
    const zoomed = view()
    expect(zoomed.scale).toBeGreaterThan(before.scale)
    // The point of the drawing under the cursor did not move.
    expect(zoomed.x + under.x * zoomed.scale).toBeCloseTo(200, 4)
    expect(zoomed.y + under.y * zoomed.scale).toBeCloseTo(150, 4)

    // At the ceiling, another turn of the wheel changes nothing at all.
    for (let turn = 0; turn < 12; turn++) {
      wheel(canvas(), { deltaY: -100, ctrlKey: true, clientX: 200, clientY: 150 })
    }
    const capped = view()
    expect(capped.scale).toBe(2.5)
    expect(percentPill().textContent).toBe('250%')
    wheel(canvas(), { deltaY: -100, ctrlKey: true, clientX: 200, clientY: 150 })
    expect(view()).toEqual(capped)
  })

  it('zooms in on a double-click over empty canvas and not over a card', async () => {
    await openRun()
    await sizeCanvas(600, 500)
    const before = view()

    await act(async () => {
      fireEvent.doubleClick(canvas(), { clientX: 100, clientY: 100 })
      await settled()
    })
    const zoomed = view()
    expect(zoomed.scale).toBeCloseTo(before.scale * 1.5, 6)

    // On a card a double-click selects and does nothing else.
    await act(async () => {
      fireEvent.click(cardFor('builder'))
      fireEvent.doubleClick(cardFor('builder'))
      await settled()
    })
    expect(detailHeader()).toBe('builder')
    expect(view()).toEqual(zoomed)
  })
})

describe('pan, and the click that still selects', () => {
  it('pans with a drag from anywhere, cards included, and selects nothing', async () => {
    await openRun()
    await sizeCanvas(600, 500)
    const before = view()

    await press(cardFor('builder'), { x: 120, y: 120 }, { x: 180, y: 90 })

    // One for one with the pointer, and the drag did not select the card it
    // began on.
    const panned = view()
    expect(panned.x).toBeCloseTo(before.x + 60, 6)
    expect(panned.y).toBeCloseTo(before.y - 30, 6)
    expect(panned.scale).toBe(before.scale)
    expect(detailHeader()).toBe('gate-alignment-1')
    expect(pill('fit')).toHaveAttribute('aria-pressed', 'false')
  })

  it('selects on a press that barely moved, and moves the view not at all', async () => {
    await openRun()
    await sizeCanvas(600, 500)
    const before = view()

    await press(cardFor('review-1'), { x: 120, y: 120 }, { x: 122, y: 121 })

    expect(detailHeader()).toBe('review-1')
    expect(cardFor('review-1').className).toContain('sel')
    // Selecting is not a gesture: the view is where it was, and fit is live.
    expect(view()).toEqual(before)
    expect(pill('fit')).toHaveAttribute('aria-pressed', 'true')
  })

  it('changes nothing when the press was on empty canvas', async () => {
    await openRun()
    await sizeCanvas(600, 500)
    const before = view()

    await press(canvas(), { x: 10, y: 10 }, { x: 11, y: 11 })

    expect(detailHeader()).toBe('gate-alignment-1')
    expect(view()).toEqual(before)
  })

  it('shows the grabbing cursor while a drag pans, and lets it go after', async () => {
    await openRun()
    await sizeCanvas(600, 500)

    await act(async () => {
      fireEvent.pointerDown(canvas(), { button: 0, clientX: 40, clientY: 40 })
      await settled()
    })
    expect(canvas().className).not.toContain('dragging')

    await act(async () => {
      fireEvent.pointerMove(window, { clientX: 90, clientY: 40 })
      await settled()
    })
    expect(canvas().className).toContain('dragging')

    await act(async () => {
      fireEvent.pointerUp(window, { clientX: 90, clientY: 40 })
      await settled()
    })
    expect(canvas().className).not.toContain('dragging')
  })

  it('takes a plain wheel as a pan on both axes and never as a zoom', async () => {
    await openRun()
    await sizeCanvas(600, 500)
    const before = view()

    expect(wheel(canvas(), { deltaX: 30, deltaY: -20 })).toBe(true)

    const after = view()
    expect(after.scale).toBe(before.scale)
    expect(after.x).toBeCloseTo(before.x - 30, 6)
    expect(after.y).toBeCloseTo(before.y + 20, 6)
    // Taken by the canvas, so nothing outside it scrolls; the detail column's
    // own wheel is left alone.
    const detail = document.querySelector('.detail') as HTMLElement
    const passed = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 40 })
    detail.dispatchEvent(passed)
    expect(passed.defaultPrevented).toBe(false)
  })
})

describe('the keyboard', () => {
  it('keeps every card a button, in record order, that selects when activated', async () => {
    await openRun()
    await sizeCanvas(600, 500)

    const cards = within(document.querySelector('.gcanvas') as HTMLElement).getAllByRole('button')
    expect(cards.map((card) => card.querySelector('.nm')?.textContent)).toEqual([
      'planner',
      'builder',
      'review-1',
      'fixer-1',
      'review-2',
      'gate-alignment-1'
    ])

    await act(async () => {
      cardFor('fixer-1').focus()
      fireEvent.click(cardFor('fixer-1'))
      await settled()
    })
    expect(detailHeader()).toBe('fixer-1')
  })

  it('brings a card the focus lands on into view', async () => {
    await openRun()
    await sizeCanvas(300, 200)

    // Zoomed in far enough that the end of the run is off the pane.
    for (let turn = 0; turn < 10; turn++) {
      wheel(canvas(), { deltaY: -100, metaKey: true, clientX: 0, clientY: 0 })
    }
    const before = view()
    const card = cardFor('gate-alignment-1')
    const top = Number.parseFloat(card.style.top)
    expect(before.y + top * before.scale).toBeGreaterThan(200)

    await act(async () => {
      card.focus()
      await settled()
    })
    const after = view()
    expect(after.scale).toBe(before.scale)
    expect(after.y + (top + Number.parseFloat(card.style.height)) * after.scale).toBeLessThanOrEqual(
      200.001
    )
  })

  it('gives both pills a name and a role of their own', async () => {
    await openRun()
    await sizeCanvas(300, 300)

    expect(pill('fit')).toBeInTheDocument()
    expect(pill(new RegExp(`^${percentPill().textContent}$`))).toBe(percentPill())
    expect(percentPill()).toHaveAttribute('title', 'Set zoom to 100%')
  })
})
