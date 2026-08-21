// @vitest-environment jsdom
//
// The run graph as a person meets it: cards named by their whole id, drawn
// edges whose state says where the walk has got to, a splitter that gives the
// graph the room it needs, and full screen for the run that got away. Driven
// through the same scripted run seam as the other run surfaces — the record
// is the whole input.
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
      title: 'the run graph',
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

/** A build mid-flight: a fan-out walked, a fan-in ahead of the walk. */
function runOf(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'en42',
    workflow: 'build',
    status: 'running',
    workspacePath: '/repos/crucible',
    workspaceName: 'crucible',
    sessionId: 's1',
    branch: 'crucible/run-en42',
    inputs: {},
    nodes: [
      nodeOf('planner', []),
      nodeOf('builder', ['planner']),
      nodeOf('review-code', ['builder'], {
        status: 'running',
        endedAt: undefined,
        now: 'reading the diff…'
      }),
      nodeOf('review-tests', ['builder'], {
        status: 'failed',
        error: 'the suite never finished: npm test timed out\nafter 10m of silence'
      }),
      nodeOf('gate-alignment-1', ['review-code', 'review-tests'], {
        status: 'pending',
        startedAt: undefined,
        endedAt: undefined
      })
    ],
    createdAt: '2026-08-21T10:00:00.000Z',
    startedAt: '2026-08-21T10:00:00.000Z',
    ...overrides
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

const graph = (): HTMLElement => screen.getByLabelText('Run graph')

const cards = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.nd')]

const cardFor = (id: string): HTMLElement => {
  const found = cards().find((card) => card.querySelector('.nm')?.textContent === id)
  if (found === null || found === undefined) throw new Error(`no card for ${id}`)
  return found
}

/** One edge's classes, by the pair of nodes it joins. */
function edgeClass(from: string, to: string): string {
  const paths = [...document.querySelectorAll<SVGPathElement>('.cstage svg path')]
  const layout = [...document.querySelectorAll<HTMLElement>('.nd')]
  expect(paths.length).toBeGreaterThan(0)
  expect(layout.length).toBeGreaterThan(0)
  const at = edgeIndex(from, to)
  return paths[at].getAttribute('class') ?? ''
}

// The edges are drawn in record order, parents in the order the node names
// them, which is what the pure layout promises and what this reads back.
function edgeIndex(from: string, to: string): number {
  const record = runOf().nodes
  let at = 0
  for (const node of record) {
    for (const parent of node.parents) {
      if (parent === from && node.id === to) return at
      at += 1
    }
  }
  throw new Error(`no edge ${from}→${to}`)
}

const detailHeader = (): string =>
  document.querySelector('.detail .dhead .n')?.textContent ?? ''

/** A window of a known width, since jsdom lays nothing out on its own. */
async function widen(width: number): Promise<void> {
  const body = document.querySelector('.rvbody') as HTMLElement
  body.getBoundingClientRect = () =>
    ({ left: 0, right: width, width, top: 0, bottom: 800, height: 800, x: 0, y: 0 }) as DOMRect
  await act(async () => {
    window.dispatchEvent(new Event('resize'))
    await settled()
  })
}

const paneWidth = (): number => {
  const wrap = document.querySelector('.gwrap') as HTMLElement
  return Number.parseFloat(wrap.style.width)
}

async function drag(to: number): Promise<void> {
  const handle = screen.getByRole('separator', { name: 'Resize the run graph' })
  await act(async () => {
    fireEvent.mouseDown(handle, { clientX: 640 })
    fireEvent.mouseMove(window, { clientX: to })
    fireEvent.mouseUp(window)
    await settled()
  })
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('the drawn graph', () => {
  it('draws one card per node, every id whole, and one line per edge', async () => {
    await openRun()

    expect(cards().map((card) => card.querySelector('.nm')?.textContent)).toEqual([
      'planner',
      'builder',
      'review-code',
      'review-tests',
      'gate-alignment-1'
    ])
    // Each card is the button the run view has always made it.
    for (const id of ['planner', 'gate-alignment-1']) {
      expect(within(graph()).getByRole('button', { name: new RegExp(`^${id}`) })).toBe(
        cardFor(id)
      )
    }
    // Five edges: two down the trunk, a fan-out of two, a fan-in of two.
    expect(document.querySelectorAll('.cstage svg path')).toHaveLength(5)
    // Every card is placed by the layout, never by the flow of the document.
    expect(cardFor('builder').style.top).not.toBe(cardFor('planner').style.top)
  })

  it('says a status in words, with its duration, and never in colour alone', async () => {
    await openRun()

    expect(cardFor('planner')).toHaveTextContent('done · 12m')
    expect(cardFor('review-code')).toHaveTextContent(/running · /)
    expect(cardFor('gate-alignment-1')).toHaveTextContent('pending')
    expect(cardFor('review-code')).toHaveTextContent('▸ reading the diff…')
  })

  it('puts a failed node\u2019s reason on its own card, first line and no more', async () => {
    await openRun()

    expect(cardFor('review-tests')).toHaveTextContent('failed')
    expect(cardFor('review-tests')).toHaveTextContent('the suite never finished: npm test timed out')
    expect(cardFor('review-tests')).not.toHaveTextContent('after 10m of silence')
  })

  it('draws a planned edge dashed and a walked one solid, as the run walks it', async () => {
    const { workflowRuns } = await openRun()
    // The view opens on the frontier, whose edges are lit; this test is about
    // the other three states, so the selection goes somewhere out of the way.
    await act(async () => {
      fireEvent.click(cardFor('review-tests'))
      await settled()
    })

    // Ahead of the walk: either end still pending.
    expect(edgeClass('review-code', 'gate-alignment-1')).toContain('future')
    // Being walked: the child has started and not settled.
    expect(edgeClass('builder', 'review-code')).toContain('flowing')
    // Walked: the child settled.
    expect(edgeClass('planner', 'builder')).toBe('e')

    await act(async () => {
      const moved = runOf()
      workflowRuns.setRuns([
        {
          ...moved,
          nodes: moved.nodes.map((node) =>
            node.id === 'gate-alignment-1'
              ? { ...node, status: 'complete' as const, startedAt: '2026-08-21T10:20:00.000Z' }
              : node
          )
        }
      ])
      await settled()
    })
    expect(edgeClass('review-code', 'gate-alignment-1')).toBe('e')
  })

  it('holds the marching line still while the node below it is parked', async () => {
    const parked = runOf()
    await openRun([
      {
        ...parked,
        nodes: parked.nodes.map((node) =>
          node.id === 'review-code' ? { ...node, status: 'blocked' as const } : node
        )
      }
    ])
    await act(async () => {
      fireEvent.click(cardFor('review-tests'))
      await settled()
    })

    // Teal still: the work reached it and stopped there.
    expect(edgeClass('builder', 'review-code')).toBe('e flowing still')
  })

  it('lights the shown node\u2019s own edges, in and out, and nothing further', async () => {
    await openRun()

    await act(async () => {
      fireEvent.click(cardFor('builder'))
      await settled()
    })

    expect(detailHeader()).toBe('builder')
    expect(cardFor('builder').className).toContain('sel')
    expect(edgeClass('planner', 'builder')).toContain('lit')
    expect(edgeClass('builder', 'review-code')).toContain('lit')
    // One step out is not lineage: it keeps the state it had.
    expect(edgeClass('review-code', 'gate-alignment-1')).toContain('future')
  })

  it('counts the nodes in the header, dropping what is zero', async () => {
    await openRun()
    expect(graph().querySelector('.ghead .c')?.textContent).toBe(
      '5 nodes · 2 done · 1 running · 1 failed'
    )
  })
})

describe('the room the graph gets', () => {
  it('opens at 640px, resizes under the pointer, and clamps at both minima', async () => {
    await openRun()
    await widen(1400)
    expect(paneWidth()).toBe(640)

    await drag(900)
    expect(paneWidth()).toBe(900)

    // The graph never goes below 360px, whatever the drag asks for.
    await drag(80)
    expect(paneWidth()).toBe(360)

    // Nor past the detail column's own 400px.
    await drag(1390)
    expect(paneWidth()).toBe(1400 - 5 - 400)
  })

  it('remembers the width for the whole app, across a remount', async () => {
    const { view } = await openRun()
    await widen(1400)
    await drag(820)
    expect(paneWidth()).toBe(820)

    view.unmount()
    await openRun()
    expect(paneWidth()).toBe(820)
  })

  it('collapses the artifact rail before it clamps the graph down', async () => {
    await openRun()
    await widen(1400)
    expect(screen.getByLabelText('Artifacts')).toBeInTheDocument()

    // Room for the graph, the detail column and the rail: 640 + 5 + 400 + 273.
    await widen(1318)
    expect(screen.getByLabelText('Artifacts')).toBeInTheDocument()
    expect(paneWidth()).toBe(640)

    // One pixel less and the rail goes, whole; the graph keeps its width.
    await widen(1317)
    expect(screen.queryByLabelText('Artifacts')).toBeNull()
    expect(paneWidth()).toBe(640)

    // Only once the rail is gone does the graph start yielding.
    await widen(900)
    expect(paneWidth()).toBe(495)
    expect(screen.queryByLabelText('Artifacts')).toBeNull()

    // And it comes back when the width does.
    await widen(1400)
    expect(screen.getByLabelText('Artifacts')).toBeInTheDocument()
    expect(paneWidth()).toBe(640)
  })
})

describe('full screen', () => {
  const toggle = (): HTMLElement => screen.getByRole('button', { name: /full screen/ })

  it('gives the graph the whole body and Escape gives the columns back', async () => {
    await openRun()
    await widen(1400)

    await act(async () => {
      fireEvent.click(toggle())
      await settled()
    })

    expect(document.querySelector('.gwrap')).toHaveStyle({ width: '100%' })
    expect(document.querySelector('.detail')).not.toBeVisible()
    expect(screen.queryByLabelText('Artifacts')).toBeNull()
    expect(screen.queryByRole('separator', { name: 'Resize the run graph' })).toBeNull()
    // The top bar is untouched: Pause and Cancel are where they were.
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(toggle()).toHaveTextContent('exit full screen')

    // Escape unwinds one layer: the columns come back, the run stays open.
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
      await settled()
    })
    expect(document.querySelector('.detail')).toBeVisible()
    expect(screen.getByLabelText('Artifacts')).toBeInTheDocument()
    expect(screen.getByLabelText('Run en42')).toBeInTheDocument()

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
      await settled()
    })
    expect(screen.queryByLabelText('Run en42')).toBeNull()
  })

  it('is never how a run opens, however the last one was left', async () => {
    const { view } = await openRun()
    await act(async () => {
      fireEvent.click(toggle())
      await settled()
    })
    expect(document.querySelector('.detail')).not.toBeVisible()

    view.unmount()
    await openRun()
    expect(document.querySelector('.detail')).toBeVisible()
  })
})
