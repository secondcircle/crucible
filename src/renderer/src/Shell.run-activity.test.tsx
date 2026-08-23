// @vitest-environment jsdom
//
// The rail's third state: a session whose own turn ended while a run keeps
// working in its name. Driven through the run seam like every other run
// surface, because the snapshot is the only thing the rail reads runs from.
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import type { RunRecord } from '../../shared/workflows/run'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort, type ScriptedPort } from './testing/scripted-port'
import {
  createScriptedWorkflowRuns,
  type ScriptedWorkflowRuns
} from './testing/scripted-workflow-runs'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { settled } from './testing/settled'

const HERE = 'panel handoff build'
const RUNNING = 'quota strip polish'
const AWAY = 'og image pipeline'

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
      createdAt: '2026-08-21T10:00:00.000Z',
      title: HERE,
      working: false,
      fresh: false
    },
    {
      id: 's2',
      workspaceId: 'w1',
      createdAt: '2026-08-21T10:01:00.000Z',
      title: RUNNING,
      working: false,
      fresh: false
    },
    {
      id: 's3',
      workspaceId: 'w2',
      createdAt: '2026-08-21T10:02:00.000Z',
      title: AWAY,
      working: false,
      fresh: false
    }
  ]
}

/** Ages are read against the clock the rail reads, so the run gets a real one. */
function minutesAgo(minutes: number): string {
  // Twenty seconds past the minute, clear of the rounding boundary either way.
  return new Date(Date.now() - (minutes * 60_000 + 20_000)).toISOString()
}

function runOf(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: 'en42',
    workflow: 'build',
    status: 'running',
    workspacePath: '/repos/crucible',
    workspaceName: 'crucible',
    sessionId: 's2',
    worktreePath: '/repos/crucible/.crucible/worktrees/run-en42',
    branch: 'crucible/run-en42',
    inputs: {},
    nodes: [],
    createdAt: minutesAgo(18),
    startedAt: minutesAgo(18),
    ...overrides
  }
}

async function rail(
  runs: readonly RunRecord[] = []
): Promise<{ readonly port: ScriptedPort; readonly workflowRuns: ScriptedWorkflowRuns }> {
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
  await screen.findByRole('button', { name: (name) => name.startsWith(HERE) })
  await settled()
  return { port, workflowRuns }
}

/** The row, by the title it starts with — the marks follow it in the name. */
function row(title: string): HTMLElement {
  const button = screen.getByRole('button', { name: (name) => name.startsWith(title) })
  const found = button.closest('.sessrow')
  if (found === null) throw new Error(`${title} is not in a session row`)
  return found as HTMLElement
}

function nameOf(title: string): string {
  return row(title).querySelector('.sess')?.getAttribute('aria-label') ?? ''
}

function endOf(title: string): HTMLElement {
  const end = row(title).querySelector<HTMLElement>('.rowend')
  if (end === null) throw new Error(`${title} has no end slot`)
  return end
}

/** A whole turn in one session, start to finish, which is what marks it. */
async function turn(port: ScriptedPort, sessionId: string): Promise<void> {
  await act(async () => {
    await port.prompt(sessionId, 'go')
  })
  act(() => port.endTurn(sessionId))
  await settled()
}

describe('a session whose run is working', () => {
  it('counts the run\'s age in the chips\' units where the grey time was', async () => {
    await rail([runOf({})])

    const end = endOf(RUNNING)
    expect(end.querySelector('.elapsed')?.textContent).toBe('18m')
    expect(end.querySelectorAll('.typing i')).toHaveLength(3)
    // One question, one answer: no "18m ago" beside the counter.
    expect(end.querySelector('small')).toBeNull()
    expect(nameOf(RUNNING)).toBe(`${RUNNING} (run working)`)
  })

  it('leaves every other row exactly as it was', async () => {
    await rail([runOf({})])

    expect(endOf(HERE).querySelector('.elapsed')).toBeNull()
    expect(endOf(HERE).querySelector('.typing')).toBeNull()
    expect(endOf(HERE).querySelector('small')).not.toBeNull()
    expect(nameOf(HERE)).toBe(HERE)
  })

  it('shows the oldest live run, once, when two are going', async () => {
    await rail([
      runOf({ id: 'aa11', createdAt: minutesAgo(18), startedAt: minutesAgo(18) }),
      runOf({ id: 'bb22', createdAt: minutesAgo(45), startedAt: minutesAgo(45) })
    ])

    const end = endOf(RUNNING)
    expect([...end.querySelectorAll('.elapsed')].map((mark) => mark.textContent)).toEqual(['45m'])
    expect(end.querySelectorAll('.typing')).toHaveLength(1)
  })

  it('keeps the mark and the name while every live run is paused, and stops moving', async () => {
    await rail([runOf({ status: 'paused' })])

    expect(endOf(RUNNING).querySelector('.elapsed')?.textContent).toBe('18m')
    // jsdom computes no animation, so the held state is read off the class the
    // stylesheet holds still by. The one class assertion in this file.
    expect(row(RUNNING).classList.contains('held')).toBe(true)
    expect(nameOf(RUNNING)).toBe(`${RUNNING} (run working)`)
  })

  it('moves again while one of its runs still runs', async () => {
    await rail([runOf({ id: 'aa11', status: 'paused' }), runOf({ id: 'bb22' })])

    expect(row(RUNNING).classList.contains('run')).toBe(true)
    expect(row(RUNNING).classList.contains('held')).toBe(false)
  })
})

describe('the one slot, and who owns it', () => {
  it('gives it to the session\'s own turn, and says both in the name', async () => {
    const { port } = await rail([runOf({})])

    act(() =>
      port.update((snapshot) => ({
        ...snapshot,
        sessions: snapshot.sessions.map((session) =>
          session.id === 's2'
            ? {
                ...session,
                working: true,
                workingSince: new Date(Date.now() - 134_500).toISOString()
              }
            : session
        )
      }))
    )

    expect(endOf(RUNNING).querySelector('.elapsed')?.textContent).toBe('2:14')
    expect(row(RUNNING).classList.contains('run')).toBe(false)
    expect(nameOf(RUNNING)).toBe(`${RUNNING} (working, run working)`)
  })

  // The run is parked on an unanswered check-in, because that is what leaves
  // the turn markable at all: a run still working hushes its session's turn,
  // and then there is no needs-you state to win the slot.
  it('gives it to needs-you, which outranks a run', async () => {
    const { port } = await rail([runOf({ waiting: true })])

    await turn(port, 's2')

    const end = endOf(RUNNING)
    expect(end.querySelector('.pip')).not.toBeNull()
    expect(end.querySelector('small')).not.toBeNull()
    expect(end.querySelector('.elapsed')).toBeNull()
    expect(end.querySelector('.typing')).toBeNull()
    expect(nameOf(RUNNING)).toBe(`${RUNNING} (run working, needs you)`)
  })
})

describe('the workspace dot', () => {
  it('lights for a run in one of its sessions, turn or no turn', async () => {
    await rail([
      runOf({
        id: 'zz11',
        sessionId: 's3',
        workspacePath: '/repos/resume-site',
        workspaceName: 'resume-site'
      })
    ])

    expect(screen.getByRole('button', { name: 'resume-site (working)' })).toBeInTheDocument()
    // The workspace with no run of its own is untouched.
    expect(screen.getByRole('button', { name: 'crucible' })).toBeInTheDocument()
  })
})

describe('what an unattended run marks', () => {
  it('marks nothing: no row, no workspace', async () => {
    await rail([runOf({ sessionId: undefined })])

    expect(document.querySelectorAll('.sessrow.run')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'crucible' })).toBeInTheDocument()
    expect(nameOf(RUNNING)).toBe(RUNNING)
  })
})

describe('when the run ends', () => {
  it('drops the counter, the dots and the name, leaving the relative time', async () => {
    const { workflowRuns } = await rail([runOf({})])
    expect(endOf(RUNNING).querySelector('.elapsed')).not.toBeNull()

    await act(async () => {
      workflowRuns.setRuns([runOf({ status: 'complete', endedAt: new Date().toISOString() })])
      await settled()
    })

    const end = endOf(RUNNING)
    expect(end.querySelector('.elapsed')).toBeNull()
    expect(end.querySelector('.typing')).toBeNull()
    expect(end.querySelector('small')).not.toBeNull()
    expect(nameOf(RUNNING)).toBe(RUNNING)
    expect(row(RUNNING).classList.contains('run')).toBe(false)
    // Nothing was announced and nothing asks: a run ending is not attention.
    expect(end.querySelector('.pip')).toBeNull()
  })

  it('picks the mark up when a run starts later', async () => {
    const { workflowRuns } = await rail([])
    expect(endOf(RUNNING).querySelector('.elapsed')).toBeNull()

    await act(async () => {
      workflowRuns.setRuns([runOf({})])
      await settled()
    })

    expect(endOf(RUNNING).querySelector('.elapsed')?.textContent).toBe('18m')
    expect(nameOf(RUNNING)).toBe(`${RUNNING} (run working)`)
  })
})
