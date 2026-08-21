// @vitest-environment jsdom
//
// The three run surfaces, driven through the run seam: the session-scoped
// strip, the full-screen read-only dig, and the global ⌘R view. Everything a
// run says arrives in the chat through the port like any other message, so
// what is tested here is observation — no surface here can talk to a run.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import type { RunRecord } from '../../shared/workflows/run'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort } from './testing/scripted-port'
import { createScriptedWorkflowRuns } from './testing/scripted-workflow-runs'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { settled } from './testing/settled'

const SNAPSHOT: ShellSnapshot = {
  workspaces: [
    { id: 'w1', name: 'crucible', path: '/repos/crucible' },
    { id: 'w2', name: 'resume-site', path: '/repos/resume-site' }
  ],
  activeWorkspaceId: 'w1',
  activeSessionId: 's1',
  sessions: [
    {
      id: 's1',
      workspaceId: 'w1',
      createdAt: '2026-08-20T10:00:00.000Z',
      title: 'panel handoff build',
      working: false,
      fresh: false
    },
    {
      id: 's2',
      workspaceId: 'w1',
      createdAt: '2026-08-20T10:01:00.000Z',
      title: 'quota strip polish',
      working: false,
      fresh: false
    }
  ]
}

function runOf(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: 'en42',
    workflow: 'build',
    status: 'running',
    workspacePath: '/repos/crucible',
    workspaceName: 'crucible',
    sessionId: 's1',
    worktreePath: '/repos/crucible/.crucible/worktrees/run-en42',
    branch: 'crucible/run-en42',
    baseCommit: '6c90bb0abcdef',
    inputs: {},
    nodes: [
      {
        id: 'planner',
        status: 'complete',
        parents: [],
        model: 'anthropic/claude-fable-5:high',
        reads: [],
        artifacts: [{ name: 'spec', path: '/state/spec.md', desc: 'the Spec' }],
        summary: 'wrote the spec',
        cost: 0.61,
        startedAt: '2026-08-20T10:00:00.000Z',
        endedAt: '2026-08-20T10:04:00.000Z'
      },
      {
        id: 'builder',
        status: 'running',
        parents: ['planner'],
        model: 'anthropic/claude-opus-5:high',
        reads: [],
        artifacts: [],
        toolCalls: 17,
        contextPercent: 22,
        cost: 2.87,
        now: 'running bash…',
        startedAt: '2026-08-20T10:04:00.000Z',
        lastActivityAt: '2026-08-20T10:15:00.000Z'
      }
    ],
    createdAt: '2026-08-20T10:00:00.000Z',
    startedAt: '2026-08-20T10:00:00.000Z',
    ...overrides
  }
}

const bands = (): string[] =>
  [...document.querySelectorAll('.band .bandhead .n')].map((head) => head.textContent ?? '')

const count = (): string => document.querySelector('.gvtop .count')?.textContent ?? ''

const row = (id: string): HTMLElement | null =>
  [...document.querySelectorAll<HTMLElement>('.runrow')].find(
    (found) => found.querySelector('.id')?.textContent === id
  ) ?? null

/** The run ids in one band, in the order the band renders them. */
function rowsOf(band: string): string[] {
  const held = [...document.querySelectorAll('.band')].find(
    (found) => found.querySelector('.bandhead .n')?.textContent === band
  )
  return [...(held?.querySelectorAll('.runrow .id') ?? [])].map((cell) => cell.textContent ?? '')
}

/** ⌘R, opened, with the runs the test wrote. */
async function open(runs: readonly RunRecord[]): Promise<void> {
  mount(runs)
  await act(settled)
  await act(async () => {
    fireEvent.keyDown(document, { key: 'r', metaKey: true })
    await settled()
  })
}

function mount(runs: readonly RunRecord[]) {
  const port = createScriptedPort(SNAPSHOT)
  const workflowRuns = createScriptedWorkflowRuns(runs)
  render(
    <Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
      workflowRuns={workflowRuns}
    />
  )
  return { port, workflowRuns }
}

describe('the run strip', () => {
  it('shows one chip per live run of the active session and none of anyone else', async () => {
    await act(async () => {
      mount([
        runOf({}),
        runOf({ id: 'zz11', sessionId: 's2', workflow: 'adhoc' }),
        runOf({ id: 'dd99', status: 'complete', endedAt: '2026-08-20T11:00:00.000Z' })
      ])
      await settled()
    })

    const strip = screen.getByRole('toolbar', { name: 'Runs' })
    const chips = within(strip).getAllByRole('button')
    expect(chips).toHaveLength(1)
    expect(chips[0]).toHaveTextContent('build')
    expect(chips[0]).toHaveTextContent('▸ builder')
    expect(chips[0]).toHaveTextContent('$3.48')
  })

  it('is absent entirely when the session has no live runs', async () => {
    await act(async () => {
      mount([runOf({ status: 'complete' })])
      await settled()
    })
    expect(screen.queryByRole('toolbar', { name: 'Runs' })).toBeNull()
  })

  it('turns a chip amber with the routed label while the run waits on its agent', async () => {
    await act(async () => {
      mount([
        runOf({
          waiting: true,
          question: { reason: 'which way?', raisedAt: '2026-08-20T10:10:00.000Z' }
        })
      ])
      await settled()
    })
    expect(screen.getByText('⚑ asked the agent')).toBeInTheDocument()
  })
})

describe('the run view', () => {
  it('opens full screen from a chip, read-only, and Esc goes back', async () => {
    const { workflowRuns } = mount([runOf({})])
    await act(settled)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /build.*builder/s }))
      await settled()
    })

    const view = screen.getByLabelText('Run en42')
    expect(view).toHaveTextContent('run en42')
    expect(view).toHaveTextContent('crucible/run-en42')
    expect(view).toHaveTextContent('from 6c90bb0')
    // The node detail follows the running node and asked for its transcript.
    expect(workflowRuns.calls).toContainEqual({
      op: 'nodeTranscript',
      args: ['en42', 'builder']
    })
    // No input anywhere: the view has buttons, never a textbox.
    expect(within(view).queryByRole('textbox')).toBeNull()

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
      await settled()
    })
    expect(screen.queryByLabelText('Run en42')).toBeNull()
  })

  it('renders the selected node transcript through the chat pane and clicks through the graph', async () => {
    const { workflowRuns } = mount([runOf({})])
    workflowRuns.transcripts.set('en42:planner', [
      { kind: 'assistant', markdown: 'the spec holds' }
    ])
    await act(settled)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /build.*builder/s }))
      await settled()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /planner/ }))
      await settled()
    })
    expect(screen.getByText('the spec holds')).toBeInTheDocument()
  })

  it('Pause and Cancel reach the service; a parked run shows the routed banner', async () => {
    const { workflowRuns } = mount([
      runOf({
        waiting: true,
        question: {
          reason: 'third review round on the same argument',
          nodeId: 'builder',
          raisedAt: '2026-08-20T10:12:00.000Z'
        }
      })
    ])
    await act(settled)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /asked the agent/ }))
      await settled()
    })

    expect(screen.getByRole('status')).toHaveTextContent('third review round')
    expect(screen.getByRole('status')).toHaveTextContent('sent to this run')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      await settled()
    })
    expect(workflowRuns.calls).toContainEqual({ op: 'pause', args: ['en42'] })
    expect(workflowRuns.calls).toContainEqual({ op: 'cancel', args: ['en42'] })
  })
})

describe('the global runs view', () => {
  it('opens on ⌘R, bands every run by what it wants from you, and closes on Esc', async () => {
    mount([
      runOf({}),
      runOf({
        id: 'f7k1',
        workflow: 'adhoc',
        waiting: true,
        sessionId: 's2',
        question: { reason: 'which way?', raisedAt: '2026-08-20T10:10:00.000Z' }
      }),
      runOf({
        id: 'd3p8',
        workflow: 'adhoc',
        status: 'complete',
        workspacePath: '/repos/resume-site',
        workspaceName: 'resume-site',
        sessionId: undefined,
        endedAt: '2026-08-20T11:00:00.000Z'
      })
    ])
    await act(settled)

    await act(async () => {
      fireEvent.keyDown(document, { key: 'r', metaKey: true })
      await settled()
    })

    const view = screen.getByLabelText('All runs')
    expect(bands()).toEqual(['Running', 'Needs you', 'Done'])
    expect(rowsOf('Running')).toEqual(['en42'])
    expect(rowsOf('Needs you')).toEqual(['f7k1'])
    expect(rowsOf('Done')).toEqual(['d3p8'])
    // The row is what it always was: session, spend and its buttons.
    expect(view).toHaveTextContent('from panel handoff build')
    expect(view).toHaveTextContent('unattended')

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
      await settled()
    })
    expect(screen.queryByLabelText('All runs')).toBeNull()
  })

  it('shows the workspace as a column on the row, with no grouping left', async () => {
    await open([
      runOf({}),
      runOf({
        id: 'k2m9',
        workspacePath: '/repos/resume-site',
        workspaceName: 'resume-site',
        sessionId: 's2'
      })
    ])

    expect(
      [...document.querySelectorAll('.runrow .ws')].map((column) => column.textContent)
    ).toEqual(['crucible', 'resume-site'])
    // The workspace heading of the old view is gone entirely.
    expect(screen.getByLabelText('All runs').querySelector('.wsgroup')).toBeNull()
  })

  it('leaves an empty band out rather than heading nothing', async () => {
    await open([runOf({ status: 'cancelled', endedAt: '2026-08-20T11:00:00.000Z' })])

    expect(bands()).toEqual(['Done'])
  })

  it('keeps the no-runs message when there are none at all', async () => {
    await open([])

    expect(bands()).toEqual([])
    expect(screen.getByLabelText('All runs')).toHaveTextContent('No runs yet')
  })

  it('puts the newest first inside a band', async () => {
    await open([
      runOf({ id: 'older', createdAt: '2026-08-20T09:00:00.000Z' }),
      runOf({ id: 'newer', createdAt: '2026-08-20T13:00:00.000Z' })
    ])

    expect(rowsOf('Running')).toEqual(['newer', 'older'])
  })

  // A failed run is the one most likely to need a human: it is in Needs you,
  // in the bad tone, and never dimmed.
  it('gives a failed run its own treatment, undimmed', async () => {
    await open([
      runOf({ id: 'b1n7', status: 'failed', endedAt: '2026-08-20T11:00:00.000Z' }),
      runOf({ id: 'd3p8', status: 'complete', endedAt: '2026-08-20T11:00:00.000Z' })
    ])

    expect(rowsOf('Needs you')).toEqual(['b1n7'])
    const failed = row('b1n7')
    expect(failed?.className).toContain('failed')
    expect(failed?.className).not.toContain('done')
    expect(failed).toHaveTextContent('failed · ')
    expect(row('d3p8')?.className).toContain('done')
  })

  it('counts in the bands own words, and drops the segments that are zero', async () => {
    const { workflowRuns } = mount([
      runOf({}),
      runOf({ id: 'zz11' }),
      runOf({ id: 'n1', waiting: true }),
      runOf({ id: 'n2', status: 'paused' }),
      runOf({ id: 'n3', status: 'failed', endedAt: new Date().toISOString() }),
      runOf({ id: 'd1', status: 'complete', endedAt: new Date().toISOString() })
    ])
    await act(settled)
    await act(async () => {
      fireEvent.keyDown(document, { key: 'r', metaKey: true })
      await settled()
    })

    expect(count()).toBe('2 running · 3 need you · 1 finished today')

    await act(async () => {
      workflowRuns.setRuns([runOf({ id: 'd1', status: 'complete', endedAt: new Date().toISOString() })])
      await settled()
    })
    expect(count()).toBe('nothing running · 1 finished today')

    await act(async () => {
      workflowRuns.setRuns([runOf({ id: 'n3', status: 'failed' })])
      await settled()
    })
    expect(count()).toBe('nothing running · 1 needs you')
  })

  it('opens when main announces the intercepted chord as an event', async () => {
    const { workflowRuns } = mount([runOf({})])
    await act(settled)
    await act(async () => {
      workflowRuns.emitToggle()
      await settled()
    })
    expect(screen.getByLabelText('All runs')).toBeInTheDocument()
  })

  it('Go to session lands in the orchestrator session; Start session opens one in the run workspace', async () => {
    const { port } = mount([
      runOf({}),
      runOf({
        id: 'g8x2',
        sessionId: undefined,
        workspacePath: '/repos/resume-site',
        workspaceName: 'resume-site'
      })
    ])
    await act(settled)

    await act(async () => {
      fireEvent.keyDown(document, { key: 'r', metaKey: true })
      await settled()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Go to session' }))
      await settled()
    })
    expect(port.calls).toContainEqual({ op: 'activateSession', args: ['s1'] })
    expect(screen.queryByLabelText('All runs')).toBeNull()

    await act(async () => {
      fireEvent.keyDown(document, { key: 'r', metaKey: true })
      await settled()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start session' }))
      await settled()
    })
    expect(port.calls).toContainEqual({ op: 'createSession', args: ['w2'] })
  })
})
