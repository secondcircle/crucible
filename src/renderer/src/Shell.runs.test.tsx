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

/** The buttons on one run's row, in the order the row lays them out. */
const buttonsOf = (id: string): string[] =>
  [...(row(id)?.querySelectorAll('button') ?? [])].map((button) => button.textContent ?? '')

const investigateIn = (id: string): HTMLButtonElement | undefined =>
  [...(row(id)?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (button) => button.textContent === 'Investigate'
  )

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
      // The graph's own node, not the rail row that names it as a producer.
      const graph = screen.getByLabelText('Run graph')
      fireEvent.click(within(graph).getByRole('button', { name: /planner/ }))
      await settled()
    })
    expect(screen.getByText('the spec holds')).toBeInTheDocument()
  })

  it('Pause reaches the service; a parked run shows the routed banner', async () => {
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
      await settled()
    })
    expect(workflowRuns.calls).toContainEqual({ op: 'pause', args: ['en42'] })
  })

  // One dialog, wherever Cancel is offered: the header path asks exactly as
  // the row path does.
  it('Cancel in the header raises the confirm, and confirming stops the run', async () => {
    const { workflowRuns } = mount([runOf({})])
    await act(settled)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /build.*builder/s }))
      await settled()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      await settled()
    })

    expect(screen.getByRole('dialog', { name: 'Cancel this run?' })).toBeInTheDocument()
    expect(workflowRuns.calls).not.toContainEqual({ op: 'cancel', args: ['en42'] })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel the run' }))
      await settled()
    })
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

  it('Go to session lands in the orchestrator session', async () => {
    const { port } = mount([runOf({})])
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
  })

  // Start session offered a chat that knew nothing about the run. Investigate
  // took its slot, its emphasis, and its job.
  it('has no Start session anywhere; Investigate is primary on the session-less row', async () => {
    await open([
      runOf({}),
      runOf({
        id: 'g8x2',
        sessionId: undefined,
        workspacePath: '/repos/resume-site',
        workspaceName: 'resume-site'
      })
    ])

    expect(screen.queryByRole('button', { name: 'Start session' })).toBeNull()
    expect(buttonsOf('en42')).toEqual(['Open run', 'Go to session', 'Investigate'])
    expect(buttonsOf('g8x2')).toEqual(['Open run', 'Investigate'])
    expect(investigateIn('g8x2')?.className).toContain('primary')
    expect(investigateIn('en42')?.className).not.toContain('primary')
  })
})

// One button, two states, on the rows that are asking for something.
describe('clearing a run that needs you', () => {
  it('offers Cancel on the live rows, Dismiss on the failed one, and neither elsewhere', async () => {
    await open([
      runOf({}),
      runOf({
        id: 'park',
        waiting: true,
        question: { reason: 'which way?', raisedAt: '2026-08-20T10:10:00.000Z' }
      }),
      runOf({ id: 'paus', status: 'paused' }),
      runOf({ id: 'fail', status: 'failed', endedAt: '2026-08-20T11:00:00.000Z' }),
      runOf({ id: 'done', status: 'complete', endedAt: '2026-08-20T11:00:00.000Z' })
    ])

    expect(buttonsOf('park')).toEqual(['Open run', 'Go to session', 'Cancel', 'Investigate'])
    expect(buttonsOf('paus')).toEqual(['Open run', 'Go to session', 'Cancel', 'Investigate'])
    expect(buttonsOf('fail')).toEqual(['Open run', 'Go to session', 'Dismiss', 'Investigate'])
    // A healthy running row is not asking, and a done row asks nothing.
    expect(buttonsOf('en42')).toEqual(['Open run', 'Go to session', 'Investigate'])
    expect(buttonsOf('done')).toEqual(['Open run', 'Go to session', 'Investigate'])
  })

  it('dismisses without a confirm, disables the button, and re-bands on the snapshot', async () => {
    const { workflowRuns } = mount([
      runOf({ id: 'fail', status: 'failed', endedAt: '2026-08-20T11:00:00.000Z' })
    ])
    await act(settled)
    await act(async () => {
      fireEvent.keyDown(document, { key: 'r', metaKey: true })
      await settled()
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
      await settled()
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(workflowRuns.calls).toContainEqual({ op: 'dismiss', args: ['fail'] })
    expect((screen.getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    // Still in Needs you until the record says otherwise.
    expect(rowsOf('Needs you')).toEqual(['fail'])

    await act(async () => {
      workflowRuns.setRuns([
        runOf({
          id: 'fail',
          status: 'failed',
          endedAt: '2026-08-20T11:00:00.000Z',
          dismissedAt: '2026-08-20T12:00:00.000Z'
        })
      ])
      await settled()
    })

    expect(bands()).toEqual(['Done'])
    expect(rowsOf('Done')).toEqual(['fail'])
    // The row stops shouting: dimmed, saying it was dismissed, still openable.
    const cleared = row('fail')
    expect(cleared?.className).toContain('done')
    expect(cleared?.className).not.toContain('failed')
    expect(cleared?.querySelector('.st')?.textContent).toMatch(/^failed · dismissed · /)
    expect(buttonsOf('fail')).toEqual(['Open run', 'Go to session', 'Investigate'])
    // And it never counts as work finished today.
    expect(count()).toBe('nothing running')
  })

  // The race: the run settles between the Cancel click and the confirm.
  // The cancel is refused and reported, and the row — now a
  // failed one offering Dismiss — must still be clearable: the disabled mark
  // set on confirm belongs to a cancel that never happened.
  it('leaves the row clearable when the run settled before the confirm', async () => {
    const { workflowRuns } = mount([
      runOf({
        id: 'paus',
        status: 'paused',
        endedAt: undefined
      })
    ])
    // The live engine refuses a cancel on a settled run with this sentence.
    workflowRuns.cancel = async () => {
      throw new Error('The run "paus" is not live.')
    }
    await act(settled)
    await act(async () => {
      fireEvent.keyDown(document, { key: 'r', metaKey: true })
      await settled()
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      await settled()
    })
    // While the confirm is up, the run fails: the snapshot re-bands the row
    // as a failed one, whose button is Dismiss.
    await act(async () => {
      workflowRuns.setRuns([
        runOf({ id: 'paus', status: 'failed', endedAt: '2026-08-20T11:00:00.000Z' })
      ])
      await settled()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel the run' }))
      await settled()
    })

    // The refusal is said out loud, where every other refusal is said.
    expect(screen.getByRole('alert')).toHaveTextContent('The run "paus" is not live.')
    // The cancel was refused, so nothing about this run was cleared: its
    // Dismiss must still be a button, not a control dead until ⌘R reopens.
    const dismiss = screen.getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement
    expect(dismiss.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(dismiss)
      await settled()
    })
    expect(workflowRuns.calls).toContainEqual({ op: 'dismiss', args: ['paus'] })
  })

  // A dismiss can fail on transport, and the engine refuses a live one with a
  // sentence. Either way the row says so and hands the button back: the run
  // is still sitting in Needs you, still asking.
  it('reports a refused dismiss and gives the button back', async () => {
    const { workflowRuns } = mount([
      runOf({ id: 'fail', status: 'failed', endedAt: '2026-08-20T11:00:00.000Z' })
    ])
    workflowRuns.dismiss = async () => {
      throw new Error('The runs service is not answering.')
    }
    await act(settled)
    await act(async () => {
      fireEvent.keyDown(document, { key: 'r', metaKey: true })
      await settled()
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
      await settled()
    })

    expect(screen.getByRole('alert')).toHaveTextContent('The runs service is not answering.')
    const dismiss = screen.getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement
    expect(dismiss.disabled).toBe(false)
    expect(rowsOf('Needs you')).toEqual(['fail'])
  })

  it('asks before cancelling, in the pinned words, and does nothing when declined', async () => {
    const { workflowRuns } = mount([runOf({ id: 'paus', status: 'paused' })])
    await act(settled)
    await act(async () => {
      fireEvent.keyDown(document, { key: 'r', metaKey: true })
      await settled()
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      await settled()
    })
    // The confirm is the click's acknowledgment, and the button behind it is
    // dead for the flight, so no second click can raise a second confirm.
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    const dialog = screen.getByRole('dialog', { name: 'Cancel this run?' })
    expect(dialog).toHaveTextContent('Its agents stop where they stand')
    expect(dialog).toHaveTextContent('The worktree, branch and artifacts all stay.')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Let it keep working' }))
      await settled()
    })
    expect(workflowRuns.calls).toEqual([])
    // The run keeps working, so its button is a button again.
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      false
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      await settled()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel the run' }))
      await settled()
    })
    expect(workflowRuns.calls).toContainEqual({ op: 'cancel', args: ['paus'] })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })
})

describe('investigating a run', () => {
  it('makes a session in the run workspace, adopts the run, then prompts it', async () => {
    const { port, workflowRuns } = mount([
      runOf({
        id: 'fail',
        status: 'failed',
        endedAt: '2026-08-20T11:00:00.000Z',
        error: 'the builder never wrote its changes file',
        dir: '/state/workflow-runs/fail',
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
      fireEvent.click(screen.getByRole('button', { name: 'Investigate' }))
      await settled()
    })

    const created = port.calls.find((call) => call.op === 'createSession')
    const prompted = port.calls.find((call) => call.op === 'prompt')
    // The session is made in the run's own workspace, not the active one.
    expect(created?.args).toEqual(['w2'])
    const sessionId = String(prompted?.args[0])
    // Adopted before the prompt went out, so crucible_runs already lists it.
    expect(workflowRuns.calls).toContainEqual({ op: 'adopt', args: ['fail', sessionId] })
    expect(port.calls.findIndex((call) => call.op === 'prompt')).toBeGreaterThan(
      port.calls.findIndex((call) => call.op === 'activateSession')
    )
    expect(port.snapshotNow.activeSessionId).toBe(sessionId)

    const text = String(prompted?.args[1])
    expect(text).toContain('fail')
    expect(text).toContain('failed')
    expect(text).toContain('crucible/run-en42')
    expect(text).toContain('the builder never wrote its changes file')
    expect(text).toContain('/state/workflow-runs/fail')
    // Echoed in the transcript, and the region is gone: you land in the chat.
    expect(screen.getByText(/Investigate Crucible run fail/)).toBeTruthy()
    expect(screen.queryByLabelText('All runs')).toBeNull()
  })

  it('disables the button for the whole flight, so one click makes one session', async () => {
    const { port } = mount([runOf({})])
    await act(settled)
    await act(async () => {
      fireEvent.keyDown(document, { key: 'r', metaKey: true })
      await settled()
    })

    // Held open the way a real session creation is.
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const create = port.createSession.bind(port)
    port.createSession = async (workspaceId: string) => {
      await held
      return create(workspaceId)
    }

    const button = (): HTMLButtonElement =>
      screen.getByRole('button', { name: 'Investigate' }) as HTMLButtonElement
    await act(async () => {
      fireEvent.click(button())
      await settled()
    })
    expect(button().disabled).toBe(true)
    await act(async () => {
      fireEvent.click(button())
      await settled()
    })

    await act(async () => {
      release()
      await settled()
    })
    expect(port.calls.filter((call) => call.op === 'createSession')).toHaveLength(1)
  })

  it('says why it cannot act when the run workspace is not in the sidebar', async () => {
    await open([
      runOf({ id: 'away', workspacePath: '/repos/elsewhere', workspaceName: 'elsewhere' })
    ])

    const button = investigateIn('away')
    expect(button?.disabled).toBe(true)
    expect(button?.title).toBe(
      'Add elsewhere to the sidebar first — an investigation runs in a session of its own.'
    )
  })

  it('is offered in the run view header too, whatever the run status', async () => {
    const { port, workflowRuns } = mount([
      runOf({ id: 'd3p8', status: 'complete', endedAt: '2026-08-20T11:00:00.000Z' })
    ])
    await act(settled)
    await act(async () => {
      fireEvent.keyDown(document, { key: 'r', metaKey: true })
      await settled()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open run' }))
      await settled()
    })

    const header = screen.getByLabelText('Run d3p8').querySelector('.rvtop')
    await act(async () => {
      fireEvent.click(within(header as HTMLElement).getByRole('button', { name: 'Investigate' }))
      await settled()
    })

    expect(workflowRuns.calls.some((call) => call.op === 'adopt')).toBe(true)
    expect(port.calls.some((call) => call.op === 'prompt')).toBe(true)
    // The whole region closes on landing: the run view goes with it.
    expect(screen.queryByLabelText('Run d3p8')).toBeNull()
  })
})
