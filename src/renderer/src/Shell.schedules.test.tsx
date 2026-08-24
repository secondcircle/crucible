// @vitest-environment jsdom
//
// The schedule chip, the board behind it and the Tab walk that reaches it,
// driven through the two seams: the schedule service for what a repo
// declares, the run service for what its schedules fired. Nothing here can
// answer a run — that is the point of the surface.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import type { SchedulesSnapshot } from '../../shared/schedules/service'
import type { RunRecord } from '../../shared/workflows/run'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort, type ScriptedPort } from './testing/scripted-port'
import { createScriptedSchedules, type ScriptedSchedules } from './testing/scripted-schedules'
import { createScriptedWorkflowRuns } from './testing/scripted-workflow-runs'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { settled } from './testing/settled'

const HERE = '/repos/crucible'
const AWAY = '/repos/resume-site'

const SNAPSHOT: ShellSnapshot = {
  workspaces: [
    { id: 'w1', name: 'crucible', path: HERE },
    { id: 'w2', name: 'resume-site', path: AWAY }
  ],
  activeWorkspaceId: 'w1',
  activeSessionId: 's1',
  sessions: [
    {
      id: 's1',
      workspaceId: 'w1',
      createdAt: '2026-08-24T10:00:00.000Z',
      title: 'schedule board shape',
      working: false,
      fresh: false
    }
  ]
}

const HOUR = 3_600_000

function ago(hours: number): string {
  return new Date(Date.now() - hours * HOUR).toISOString()
}

function ahead(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

function schedules(overrides: Partial<SchedulesSnapshot> = {}): SchedulesSnapshot {
  return {
    workspaces: [
      {
        workspacePath: HERE,
        allPaused: false,
        schedules: [
          {
            workflow: 'deps-audit',
            description: 'flag risky dependency updates',
            cron: '0 7 * * 1',
            cadence: 'weekly Mon 07:00',
            hasCheck: false,
            enabled: true,
            nextFireAt: ahead(90)
          },
          {
            workflow: 'issue-watch',
            description: 'triage new issues as they appear',
            cron: '*/5 * * * *',
            cadence: 'every 5 min',
            hasCheck: true,
            enabled: true,
            nextFireAt: ahead(2),
            warning: {
              kind: 'check',
              message: '403 from api.github.com',
              since: ago(3)
            }
          },
          {
            workflow: 'triage',
            description: 'label and prioritize untriaged issues',
            cron: '0 9 * * *',
            cadence: 'daily 09:00',
            hasCheck: false,
            enabled: true,
            nextFireAt: ahead(600)
          }
        ]
      }
    ],
    ...overrides
  }
}

function runOf(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: 'e7a2',
    workflow: 'triage',
    status: 'running',
    workspacePath: HERE,
    workspaceName: 'crucible',
    scheduled: true,
    worktreePath: '/repos/crucible/.crucible/worktrees/run-e7a2',
    branch: 'crucible/run-e7a2',
    baseCommit: '41c9f02abcdef',
    inputs: {},
    nodes: [],
    createdAt: ago(4),
    startedAt: ago(4),
    ...overrides
  }
}

/** A run parked on a question, which is what lights the chip. */
function parkedRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return runOf({
    waiting: true,
    question: {
      reason: 'Issue #84 reads as both a bug report and a feature request. Which wins?',
      nodeId: 'label-issues',
      raisedAt: ago(2)
    },
    nodes: [
      {
        id: 'label-issues',
        status: 'blocked',
        parents: [],
        reads: [],
        artifacts: [],
        cost: 0.31
      }
    ],
    ...overrides
  })
}

/** A clean run with a report to read. */
function finishedRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return runOf({
    id: 'd3p8',
    status: 'complete',
    endedAt: ago(24),
    outputs: { summary: 'triaged 5 issues, 1 flagged as duplicate' },
    nodes: [
      {
        id: 'report',
        status: 'complete',
        parents: [],
        reads: [],
        artifacts: [
          {
            name: 'report',
            path: '/state/workflow-runs/d3p8/artifacts/report.md',
            desc: "the run's report",
            writtenAt: ago(24)
          }
        ],
        cost: 0.84
      }
    ],
    ...overrides
  })
}

function mount(
  runs: readonly RunRecord[] = [],
  snapshot: SchedulesSnapshot = schedules()
): {
  readonly port: ScriptedPort
  readonly scheduleService: ScriptedSchedules
  readonly workflowRuns: ReturnType<typeof createScriptedWorkflowRuns>
} {
  const port = createScriptedPort(SNAPSHOT)
  const workflowRuns = createScriptedWorkflowRuns(runs)
  const scheduleService = createScriptedSchedules(snapshot)
  render(
    <Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
      workflowRuns={workflowRuns}
      schedules={scheduleService}
    />
  )
  return { port, scheduleService, workflowRuns }
}

const chip = (): HTMLElement | null => screen.queryByRole('button', { name: 'Schedule board' })

const board = (): HTMLElement => screen.getByRole('dialog', { name: 'Schedule board' })

async function openBoard(
  runs: readonly RunRecord[] = [],
  snapshot: SchedulesSnapshot = schedules()
): Promise<ReturnType<typeof mount>> {
  const held = mount(runs, snapshot)
  await act(settled)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Schedule board' }))
    await settled()
  })
  return held
}

/** One group's rows, by the label each row carries. */
function rowsIn(group: string): string[] {
  const held = within(board()).queryByLabelText(group)
  return [...(held?.querySelectorAll('.row, .srow') ?? [])].map(
    (row) => row.getAttribute('aria-label') ?? ''
  )
}

function scheduleRow(workflow: string): HTMLElement {
  return within(board()).getByLabelText(`Schedule ${workflow}`)
}

describe('the schedule chip', () => {
  it('is absent until the scheduler has answered for this workspace', async () => {
    mount([], { workspaces: [] })
    await act(settled)
    expect(chip()).toBeNull()
  })

  it('is absent for a workspace that declares no schedules', async () => {
    mount([], { workspaces: [{ workspacePath: HERE, allPaused: false, schedules: [] }] })
    await act(settled)
    expect(chip()).toBeNull()
  })

  it('is visible and unlit while nothing is parked', async () => {
    mount([finishedRun()])
    await act(settled)

    expect(chip()).toHaveTextContent('3 schedules')
    expect(chip()?.className).not.toContain('lit')
    expect(chip()?.textContent).not.toContain('needs you')
  })

  it('lights with a count while a run of this workspace is parked', async () => {
    const { workflowRuns } = mount([parkedRun(), finishedRun()])
    await act(settled)

    expect(chip()?.className).toContain('lit')
    expect(chip()).toHaveTextContent('1 needs you')

    // Adopted: it has an orchestrator now, so it is not parked any more.
    await act(async () => {
      workflowRuns.setRuns([parkedRun({ sessionId: 's1' }), finishedRun()])
      await settled()
    })
    expect(chip()?.className).not.toContain('lit')
  })

  it('counts nothing from a parked run in another workspace', async () => {
    mount([parkedRun({ workspacePath: AWAY, workspaceName: 'resume-site' })])
    await act(settled)

    expect(chip()?.className).not.toContain('lit')
  })

  it('opens the board in the same frame, and Esc closes it', async () => {
    mount([parkedRun()])
    await act(settled)

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Schedule board' }))
    })
    expect(board()).toHaveTextContent('Schedules')
    expect(board()).toHaveTextContent('in crucible')

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
      await settled()
    })
    expect(screen.queryByRole('dialog', { name: 'Schedule board' })).toBeNull()
  })
})

describe('the board groups', () => {
  it('holds parked runs newest first, and only this workspace ones', async () => {
    await openBoard([
      parkedRun({ id: 'old1', question: undefined, status: 'failed', endedAt: ago(72) }),
      parkedRun(),
      parkedRun({ id: 'away', workspacePath: AWAY, workspaceName: 'resume-site' })
    ])

    expect(rowsIn('Needs you')).toEqual(['Parked run e7a2', 'Parked run old1'])
    const first = within(board()).getByLabelText('Parked run e7a2')
    expect(first).toHaveTextContent('asked a question')
    expect(first).toHaveTextContent('node: label-issues')
    expect(first).toHaveTextContent('⚑ waiting on answer')
    expect(within(board()).getByLabelText('Parked run old1')).toHaveTextContent('✕ failed')
  })

  it('has no Needs you group at all when nothing is parked', async () => {
    await openBoard([finishedRun()])
    expect(within(board()).queryByLabelText('Needs you')).toBeNull()
  })

  it('lists every schedule by name, with cadence, gate and next fire', async () => {
    await openBoard()

    expect(rowsIn('Schedules')).toEqual([
      'Schedule deps-audit',
      'Schedule issue-watch',
      'Schedule triage'
    ])
    // The human reading beside the raw expression, as the mock prints it.
    const watch = scheduleRow('issue-watch')
    expect(watch).toHaveTextContent('every 5 min · */5 * * * * · check')
    expect(watch).toHaveTextContent('next in 2 min')
    expect(scheduleRow('triage')).not.toHaveTextContent('· check')
  })

  it('shows the last outcome, and lets a warning outrank it', async () => {
    await openBoard([finishedRun()])

    expect(scheduleRow('triage')).toHaveTextContent('last: ✓ ok')
    // Amber, aged, and in place of whatever the last outcome was.
    const watch = scheduleRow('issue-watch')
    expect(watch).toHaveTextContent('⚠ check failing 3h · 403 from api.github.com')
    expect(watch.querySelector('.scron.err')).not.toBeNull()
    // A schedule that has never fired says nothing at all there.
    expect(scheduleRow('deps-audit')).not.toHaveTextContent('last:')
  })

  it('holds the other scheduled runs of this workspace, newest first', async () => {
    await openBoard([
      finishedRun(),
      parkedRun(),
      // Adopted and failed: its attention rides its session, so it lands here.
      runOf({ id: 'ad0p', status: 'failed', sessionId: 's1', endedAt: ago(3) }),
      runOf({ id: 'gone', status: 'complete', endedAt: ago(2), dismissedAt: ago(1) }),
      // An agent's run of the same workflow is not a scheduled run.
      runOf({ id: 'byag', scheduled: undefined, sessionId: 's1', status: 'complete' })
    ])

    expect(rowsIn('Recent runs')).toEqual(['Run ad0p', 'Run d3p8'])
    expect(within(board()).getByLabelText('Run d3p8')).toHaveTextContent(
      'triaged 5 issues, 1 flagged as duplicate'
    )
    expect(within(board()).getByLabelText('Run d3p8')).toHaveTextContent('✓ report')
  })
})

describe('the controls on a schedule row', () => {
  it('flips the toggle in the same frame and tells the service', async () => {
    const { scheduleService } = await openBoard()
    const toggle = within(scheduleRow('triage')).getByRole('switch')
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    act(() => {
      fireEvent.click(toggle)
    })

    expect(within(scheduleRow('triage')).getByRole('switch')).toHaveAttribute(
      'aria-checked',
      'false'
    )
    expect(scheduleService.calls).toContainEqual({
      op: 'setEnabled',
      args: [HERE, 'triage', false]
    })
  })

  it('pauses everything from the sub-header, and reads as the way back', async () => {
    const { scheduleService } = await openBoard()
    const control = within(board()).getByRole('button', { name: /Pause all schedules/ })

    act(() => {
      fireEvent.click(control)
    })

    const pressed = within(board()).getByRole('button', { name: /Resume all schedules/ })
    expect(pressed).toHaveAttribute('aria-pressed', 'true')
    expect(scheduleService.calls).toContainEqual({ op: 'setAllPaused', args: [HERE, true] })
    // Every row reads paused, dimmed, with no next fire named.
    expect(scheduleRow('triage')).toHaveTextContent('paused')
    expect(scheduleRow('triage').className).toContain('off')
  })

  it('shows a working state while Run now is in flight', async () => {
    const { scheduleService } = await openBoard()
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    scheduleService.runNowAnswers(() => held)

    await act(async () => {
      fireEvent.click(within(scheduleRow('triage')).getByRole('button', { name: 'Run now' }))
      await settled()
    })

    expect(within(scheduleRow('triage')).getByRole('button', { name: 'starting…' })).toBeDisabled()
    expect(scheduleService.calls).toContainEqual({ op: 'runNow', args: [HERE, 'triage'] })

    await act(async () => {
      release()
      await settled()
    })
    expect(within(scheduleRow('triage')).getByRole('button', { name: 'Run now' })).toBeEnabled()
  })

  it('lands a kickoff failure on the row as its warning', async () => {
    const { scheduleService } = await openBoard()
    scheduleService.runNowAnswers(() => Promise.reject(new Error('no trunk here')))

    await act(async () => {
      fireEvent.click(within(scheduleRow('triage')).getByRole('button', { name: 'Run now' }))
      await settled()
    })

    // The scheduler is what says so, and the board draws its snapshot.
    await act(async () => {
      const answered = schedules()
      const workspace = answered.workspaces[0]
      scheduleService.setSnapshot({
        workspaces: [
          {
            ...workspace,
            schedules: workspace.schedules.map((schedule) =>
              schedule.workflow === 'triage'
                ? {
                    ...schedule,
                    warning: {
                      kind: 'kickoff' as const,
                      message: 'no trunk here',
                      since: ago(0.1)
                    }
                  }
                : schedule
            )
          }
        ]
      })
      await settled()
    })

    expect(scheduleRow('triage')).toHaveTextContent('⚠ could not start')
    expect(scheduleRow('triage')).toHaveTextContent('no trunk here')
  })

  it('offers no Run now for a schedule whose workflow declares inputs', async () => {
    const answered = schedules()
    const workspace = answered.workspaces[0]
    await openBoard([], {
      workspaces: [
        {
          ...workspace,
          schedules: [
            {
              ...workspace.schedules[2],
              nextFireAt: undefined,
              warning: {
                kind: 'inputs',
                message: 'a scheduled fire has nobody to supply them',
                since: ago(1)
              }
            }
          ]
        }
      ]
    })

    expect(within(scheduleRow('triage')).queryByRole('button', { name: 'Run now' })).toBeNull()
    expect(scheduleRow('triage')).toHaveTextContent('⚠ needs inputs')
  })
})

describe('the reading pane', () => {
  it('shows the question verbatim, and never a box to answer it in', async () => {
    await openBoard([parkedRun()])
    const pane = screen.getByLabelText('Run reader')

    expect(pane).toHaveTextContent('run e7a2')
    expect(pane).toHaveTextContent('⚑ WAITING')
    expect(pane).toHaveTextContent('⚑ the run asks')
    expect(pane).toHaveTextContent(
      'Issue #84 reads as both a bug report and a feature request. Which wins?'
    )
    expect(pane).toHaveTextContent('It has no session and never talks to you here')
    // The facts block: what ran, where, and from which commit.
    expect(pane).toHaveTextContent('node label-issues')
    expect(pane).toHaveTextContent('/repos/crucible/.crucible/worktrees/run-e7a2')
    expect(pane).toHaveTextContent('base 41c9f02')
    // No answer box anywhere on the board: a run's only voice is a message to
    // its orchestrator.
    expect(within(board()).queryByRole('textbox')).toBeNull()
  })

  it('renders the report of a settled run through the artifact machinery', async () => {
    const { workflowRuns } = mount([finishedRun()])
    workflowRuns.artifacts.set('d3p8:/state/workflow-runs/d3p8/artifacts/report.md', {
      kind: 'markdown',
      body: '# What the run did\n\nTriaged five issues.',
      bytes: 42
    })
    await act(settled)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Schedule board' }))
      await settled()
    })

    expect(workflowRuns.calls).toContainEqual({
      op: 'artifact',
      args: ['d3p8', '/state/workflow-runs/d3p8/artifacts/report.md']
    })
    expect(screen.getByLabelText('Run reader')).toHaveTextContent('What the run did')
  })

  it('falls back to the completion line where no report was declared', async () => {
    await openBoard([
      finishedRun({ id: 'nore', nodes: [], outputs: { summary: 'nothing untriaged today' } })
    ])

    await act(async () => {
      fireEvent.click(within(board()).getByLabelText('Run nore'))
      await settled()
    })

    const pane = screen.getByLabelText('Run reader')
    expect(pane).toHaveTextContent('nothing untriaged today')
    expect(within(board()).getByLabelText('Run nore')).toHaveTextContent('✓ done')
  })

  it('offers Dismiss on a parked run and a settled one, and never on a live clean run', async () => {
    await openBoard([parkedRun(), finishedRun(), runOf({ id: 'live', waiting: undefined })])

    const footer = (): string[] =>
      [...screen.getByLabelText('Run reader').querySelectorAll('.rfoot button')].map(
        (button) => button.textContent ?? ''
      )

    expect(footer()).toEqual(['Take to a session →', 'Open run view', 'Dismiss'])

    await act(async () => {
      fireEvent.click(within(board()).getByLabelText('Run d3p8'))
      await settled()
    })
    expect(footer()).toEqual(['Take to a session →', 'Open run view', 'Dismiss'])

    // A live run doing fine: Cancel lives in the run view, which owns it.
    await act(async () => {
      fireEvent.click(within(board()).getByLabelText('Run live'))
      await settled()
    })
    expect(footer()).toEqual(['Take to a session →', 'Open run view'])
  })

  it('takes a run to a fresh session: created, adopted, activated, prompted', async () => {
    const { port, workflowRuns } = await openBoard([parkedRun()])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Take to a session →' }))
      await settled()
    })

    const created = port.calls.find((call) => call.op === 'createSession')
    const prompted = port.calls.find((call) => call.op === 'prompt')
    expect(created?.args).toEqual(['w1'])
    const sessionId = String(prompted?.args[0])
    expect(workflowRuns.calls).toContainEqual({ op: 'adopt', args: ['e7a2', sessionId] })
    expect(port.calls.findIndex((call) => call.op === 'prompt')).toBeGreaterThan(
      port.calls.findIndex((call) => call.op === 'activateSession')
    )
    expect(String(prompted?.args[1])).toContain('Issue #84')
    // You land in the chat: the board is gone.
    expect(screen.queryByRole('dialog', { name: 'Schedule board' })).toBeNull()
  })

  it('opens the run view from the pane', async () => {
    await openBoard([parkedRun()])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open run view' }))
      await settled()
    })

    expect(screen.getByLabelText('Run e7a2')).toBeInTheDocument()
  })

  it('dismisses in the frame the click lands, and stamps the record behind it', async () => {
    const { workflowRuns } = await openBoard([parkedRun(), finishedRun()])

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    })

    expect(within(board()).queryByLabelText('Parked run e7a2')).toBeNull()
    await act(settled)
    expect(workflowRuns.calls).toContainEqual({ op: 'dismiss', args: ['e7a2'] })
  })
})

describe('the Tab walk', () => {
  const tab = (): void => {
    fireEvent.keyDown(document, { key: 'Tab' })
  }

  it('takes sessions first, then parked runs, and cycles through them', async () => {
    const { port } = mount([
      parkedRun(),
      parkedRun({ id: 'old1', question: undefined, status: 'failed', endedAt: ago(72) })
    ])
    await act(settled)

    // A turn finishing in the session on screen while the window is behind
    // another app marks it, and Tab spends that mark first.
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      await port.prompt('s1', 'go')
      port.endTurn('s1')
      await settled()
    })
    await act(async () => {
      tab()
      await settled()
    })
    expect(screen.queryByRole('dialog', { name: 'Schedule board' })).toBeNull()

    // Nothing asking now: the walk moves on to the parked runs, newest first.
    await act(async () => {
      tab()
      await settled()
    })
    expect(board()).toBeInTheDocument()
    expect(within(board()).getByLabelText('Parked run e7a2').className).toContain('focused')

    // Again, while the board is open: the selection steps rather than the
    // board closing, and the run stays parked — landing is not a clearing.
    await act(async () => {
      tab()
      await settled()
    })
    expect(within(board()).getByLabelText('Parked run old1').className).toContain('focused')
    // Being parked is a fact, not a mark: landing on one clears nothing.
    expect(chip()?.className).toContain('lit')
    expect(chip()).toHaveTextContent('2 needs you')

    await act(async () => {
      tab()
      await settled()
    })
    expect(within(board()).getByLabelText('Parked run e7a2').className).toContain('focused')
  })

  it('crosses into the workspace a parked run belongs to', async () => {
    const { port } = mount([parkedRun({ workspacePath: AWAY, workspaceName: 'resume-site' })])
    await act(settled)

    await act(async () => {
      tab()
      await settled()
    })

    expect(port.calls).toContainEqual({ op: 'activateWorkspace', args: ['w2'] })
    expect(board()).toHaveTextContent('in resume-site')
    expect(within(board()).getByLabelText('Parked run e7a2').className).toContain('focused')
  })

  it('drops a run from the walk the moment it is adopted or dismissed', async () => {
    const { workflowRuns } = mount([parkedRun()])
    await act(settled)

    await act(async () => {
      workflowRuns.setRuns([parkedRun({ sessionId: 's1' })])
      await settled()
    })
    await act(async () => {
      tab()
      await settled()
    })

    expect(screen.queryByRole('dialog', { name: 'Schedule board' })).toBeNull()
  })
})
