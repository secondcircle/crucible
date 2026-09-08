// @vitest-environment jsdom
//
// Everything a live monitor puts on screen, driven through the monitor seam:
// the chip in the strip, its detail, the ⏳ on the sidebar row, the wake in
// the transcript, and what a node's wait says on a run's chip. Nothing here
// can talk to a monitor except through the seam's one action, which is Stop.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot, SystemCard } from '../../shared/agent/port'
import type { LiveMonitor } from '../../shared/monitors/monitor'
import type { RunRecord } from '../../shared/workflows/run'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedMonitors, type ScriptedMonitors } from './testing/scripted-monitors'
import { createScriptedPort, type ScriptedPort } from './testing/scripted-port'
import {
  createScriptedWorkflowRuns,
  type ScriptedWorkflowRuns
} from './testing/scripted-workflow-runs'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { settled } from './testing/settled'

const HERE = 'PR #482 CI'
const OTHER = 'quota strip polish'

const SNAPSHOT: ShellSnapshot = {
  workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
  activeWorkspaceId: 'w1',
  activeSessionId: 's1',
  sessions: [
    {
      id: 's1',
      workspaceId: 'w1',
      createdAt: '2026-09-08T10:00:00.000Z',
      title: HERE,
      working: false,
      fresh: false
    },
    {
      id: 's2',
      workspaceId: 'w1',
      createdAt: '2026-09-08T10:01:00.000Z',
      title: OTHER,
      working: false,
      fresh: false
    }
  ]
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - (minutes * 60_000 + 20_000)).toISOString()
}

function monitorOf(overrides: Partial<LiveMonitor> = {}): LiveMonitor {
  return {
    id: 'm-1f3a',
    sessionId: 's1',
    description: 'CI on PR #482 to finish',
    reason: "So I can read the failing job's log before you look at the branch again.",
    command:
      'gh pr checks 482 --json state -q \'.[] | select(.state=="IN_PROGRESS")\' | grep -q . && exit 1 || exit 0',
    cwd: '/repos/crucible',
    intervalMs: 30_000,
    timeoutMs: 30 * 60_000,
    setAt: minutesAgo(4),
    checks: 8,
    last: {
      at: minutesAgo(0),
      output: { text: 'in_progress', truncated: false },
      result: { kind: 'exited', exitCode: 1 }
    },
    ...overrides
  }
}

function runOf(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'en42',
    workflow: 'build',
    status: 'running',
    workspacePath: '/repos/crucible',
    workspaceName: 'crucible',
    sessionId: 's1',
    inputs: {},
    nodes: [
      {
        id: 'implement',
        status: 'running',
        parents: [],
        reads: [],
        artifacts: [],
        startedAt: minutesAgo(18)
      }
    ],
    createdAt: minutesAgo(18),
    startedAt: minutesAgo(18),
    ...overrides
  }
}

function mount(
  monitors: readonly LiveMonitor[] = [],
  runs: readonly RunRecord[] = []
): {
  readonly port: ScriptedPort
  readonly monitorService: ScriptedMonitors
  readonly workflowRuns: ScriptedWorkflowRuns
} {
  const port = createScriptedPort(SNAPSHOT)
  const monitorService = createScriptedMonitors(monitors)
  const workflowRuns = createScriptedWorkflowRuns(runs)
  render(
    <Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
      workflowRuns={workflowRuns}
      monitors={monitorService}
    />
  )
  return { port, monitorService, workflowRuns }
}

async function shown(
  monitors: readonly LiveMonitor[] = [],
  runs: readonly RunRecord[] = []
): Promise<ReturnType<typeof mount>> {
  const held = mount(monitors, runs)
  await act(settled)
  return held
}

const chips = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.monchip')]

const chip = (): HTMLElement => {
  const [first] = chips()
  if (first === undefined) throw new Error('no monitor chip is in the strip')
  return first
}

const detail = (): HTMLElement | null => document.querySelector<HTMLElement>('.mondetail')

function row(title: string): HTMLElement {
  const button = screen.getByRole('button', { name: (name) => name.startsWith(title) })
  const found = button.closest('.sessrow')
  if (found === null) throw new Error(`${title} is not in a session row`)
  return found as HTMLElement
}

const nameOf = (title: string): string =>
  row(title).querySelector('.sess')?.getAttribute('aria-label') ?? ''

describe('the chip in the strip', () => {
  it('shows one per live monitor of the session on screen, under its own label', async () => {
    await shown([monitorOf(), monitorOf({ id: 'm-2222', sessionId: 's2' })])

    const strip = screen.getByRole('toolbar', { name: 'Runs and monitors' })
    expect(within(strip).getByText('Waiting on')).toBeTruthy()
    expect(chips()).toHaveLength(1)
    expect(chip().textContent).toContain('CI on PR #482 to finish')
  })

  it('reads as a sentence: the description, the last output, then the timing', async () => {
    await shown([monitorOf()])

    expect(chip().querySelector('b')?.textContent).toBe('CI on PR #482 to finish')
    expect(chip().querySelector('.last')?.textContent).toBe('in_progress')
    expect(chip().querySelector('.left')?.textContent).toBe('4m · every 30s · up to 30m')
    expect(chip().querySelector('.dot')).toBeTruthy()
    expect(chip().querySelector('.x')).toBeTruthy()
  })

  it('shows the description verbatim, with the whole of it readable on hover', async () => {
    const long = 'CI on PR #482 to finish, including the e2e job that has been flaking all week'
    await shown([monitorOf({ description: long })])
    expect(chip().querySelector('b')?.textContent).toBe(long)
    expect(chip().querySelector('b')?.getAttribute('title')).toBe(long)
  })

  it('shows one line of a chatty check, and no more', async () => {
    await shown([
      monitorOf({
        last: {
          at: minutesAgo(0),
          output: { text: 'in_progress\nqueued\nqueued\n', truncated: false },
          result: { kind: 'exited', exitCode: 1 }
        }
      })
    ])
    expect(chip().querySelector('.last')?.textContent).toBe('in_progress')
  })

  it('stands beside the run chips, runs first', async () => {
    await shown([monitorOf()], [runOf()])
    const strip = screen.getByRole('toolbar', { name: 'Runs and monitors' })
    const labels = [...strip.querySelectorAll('.rslabel')].map((one) => one.textContent)
    expect(labels).toEqual(['Runs', 'Waiting on'])
    expect(strip.querySelector('.runchip')).toBeTruthy()
  })

  it('shows the strip for a session with waits and no runs at all', async () => {
    await shown([monitorOf()])
    const strip = screen.getByRole('toolbar', { name: 'Runs and monitors' })
    expect(strip.querySelector('.runchip')).toBeNull()
    expect([...strip.querySelectorAll('.rslabel')].map((one) => one.textContent)).toEqual([
      'Waiting on'
    ])
  })

  it('is no strip at all for a session with neither', async () => {
    await shown([])
    expect(document.querySelector('.runstrip')).toBeNull()
  })

  it('keeps its place when a check lands', async () => {
    const { monitorService } = await shown([
      monitorOf(),
      monitorOf({ id: 'm-2222', description: 'the npm publish of 0.4.12 to land' })
    ])
    const before = chips().map((one) => one.querySelector('b')?.textContent)

    await act(async () => {
      monitorService.setMonitors([
        monitorOf({
          last: {
            at: minutesAgo(0),
            output: { text: 'queued', truncated: false },
            result: { kind: 'exited', exitCode: 1 }
          }
        }),
        monitorOf({ id: 'm-2222', description: 'the npm publish of 0.4.12 to land' })
      ])
      await settled()
    })

    expect(chips().map((one) => one.querySelector('b')?.textContent)).toEqual(before)
    expect(chip().querySelector('.last')?.textContent).toBe('queued')
  })

  it('leaves the strip the moment its monitor ends, however it ended', async () => {
    const { monitorService } = await shown([monitorOf()])
    await act(async () => {
      monitorService.setMonitors([])
      await settled()
    })
    expect(document.querySelector('.runstrip')).toBeNull()
  })
})

describe('the ✕ on a chip', () => {
  it('stops the monitor with no confirmation, and the chip is gone in the same frame', async () => {
    const { monitorService } = await shown([monitorOf()])

    act(() => {
      fireEvent.click(within(chip()).getByRole('button', { name: /Stop watching/ }))
    })

    // Gone before the seam has answered, and nothing was asked of the user.
    expect(chips()).toHaveLength(0)
    expect(document.querySelector('.confirm')).toBeNull()
    expect(monitorService.calls).toEqual([{ op: 'stop', args: ['m-1f3a'] }])
  })
})

describe('the detail a chip opens', () => {
  async function open(): Promise<ScriptedMonitors> {
    const { monitorService } = await shown([monitorOf()])
    act(() => {
      fireEvent.click(within(chip()).getByRole('button', { name: /Waiting on/ }))
    })
    return monitorService
  }

  it('shows everything the wait is made of, the command verbatim', async () => {
    await open()
    const open_ = detail()
    expect(open_).toBeTruthy()
    const text = open_?.textContent ?? ''
    expect(text).toContain('CI on PR #482 to finish')
    expect(text).toContain("So I can read the failing job's log")
    expect(text).toContain('every 30s')
    expect(text).toContain('8 checks so far')
    expect(text).toContain('when the command exits 0, or after 30m regardless')
    expect(text).toContain('/repos/crucible (checkout)')
    expect(text).toContain('4m 20s of 30m')
    expect(open_?.querySelector('.moncmd')?.textContent).toBe(monitorOf().command)
    expect(open_?.querySelector('.bar i')).toBeTruthy()
  })

  it('shows the retained output, cut mark and all', async () => {
    const { monitorService } = await shown([monitorOf()])
    await act(async () => {
      monitorService.setMonitors([
        monitorOf({
          last: {
            at: minutesAgo(0),
            output: { text: 'a very long log line', truncated: true },
            result: { kind: 'exited', exitCode: 1 }
          }
        })
      ])
      await settled()
    })
    act(() => {
      fireEvent.click(within(chip()).getByRole('button', { name: /Waiting on/ }))
    })
    expect(detail()?.querySelector('.monout')?.textContent).toContain('a very long log line')
    expect(detail()?.querySelector('.monout')?.textContent).toContain('…')
  })

  it('keeps up as checks land, without being reopened', async () => {
    const monitorService = await open()
    expect(detail()?.textContent).toContain('8 checks so far')

    await act(async () => {
      monitorService.setMonitors([
        monitorOf({
          checks: 9,
          last: {
            at: minutesAgo(0),
            output: { text: 'queued', truncated: false },
            result: { kind: 'exited', exitCode: 1 }
          }
        })
      ])
      await settled()
    })

    // Still open, and saying what the newest check said.
    expect(detail()).toBeTruthy()
    expect(detail()?.textContent).toContain('9 checks so far')
    expect(detail()?.querySelector('.monout')?.textContent).toContain('queued')
    expect(chip().querySelector('.last')?.textContent).toBe('queued')
  })

  it('marks the chip it belongs to, and changes nothing about the monitor', async () => {
    const monitorService = await open()
    expect(chip().classList.contains('open')).toBe(true)
    expect(monitorService.calls).toEqual([])
    expect(chips()).toHaveLength(1)
  })

  it('closes on a second click and on Escape', async () => {
    await open()
    act(() => {
      fireEvent.click(within(chip()).getByRole('button', { name: /Waiting on/ }))
    })
    expect(detail()).toBeNull()

    act(() => {
      fireEvent.click(within(chip()).getByRole('button', { name: /Waiting on/ }))
    })
    expect(detail()).toBeTruthy()
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(detail()).toBeNull()
  })

  it('says the working directory is a worktree when it is not the checkout', async () => {
    await shown([monitorOf({ cwd: '/repos/crucible/.crucible/worktrees/run-5a18' })])
    act(() => {
      fireEvent.click(within(chip()).getByRole('button', { name: /Waiting on/ }))
    })
    expect(detail()?.textContent).toContain('(worktree)')
  })

  it('stops from its Stop exactly as the ✕ does', async () => {
    const monitorService = await open()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop watching' }))
    })
    expect(chips()).toHaveLength(0)
    expect(detail()).toBeNull()
    expect(monitorService.calls).toEqual([{ op: 'stop', args: ['m-1f3a'] }])
  })

  it('closes when the session on screen changes', async () => {
    const { port } = await shown([monitorOf()])
    act(() => {
      fireEvent.click(within(chip()).getByRole('button', { name: /Waiting on/ }))
    })
    expect(detail()).toBeTruthy()
    await act(async () => {
      await port.activateSession('s2')
      await settled()
    })
    expect(detail()).toBeNull()
  })
})

describe('the sidebar row', () => {
  it('wears a ⏳ and an age in the monitor color, and says so in its name', async () => {
    await shown([monitorOf()])
    const end = row(HERE).querySelector('.rowend')
    expect(end?.querySelector('.waiting')?.textContent).toBe('⏳ 4m')
    expect(nameOf(HERE)).toBe(`${HERE} (waiting)`)
  })

  it('shows the longest wait when several are live', async () => {
    await shown([
      monitorOf({ setAt: minutesAgo(4) }),
      monitorOf({ id: 'm-2222', setAt: minutesAgo(11) })
    ])
    expect(row(HERE).querySelector('.waiting')?.textContent).toBe('⏳ 11m')
  })

  it('yields the slot to a live run, which keeps its own counter', async () => {
    await shown([monitorOf()], [runOf()])
    const end = row(HERE).querySelector('.rowend')
    expect(end?.querySelector('.elapsed')?.textContent).toBe('18m')
    expect(end?.querySelector('.waiting')).toBeNull()
    // Both are still named, because the name is the whole row for anyone not
    // reading the marks.
    expect(nameOf(HERE)).toBe(`${HERE} (run working, waiting)`)
  })

  it('yields the slot to the session’s own live turn', async () => {
    const port = createScriptedPort({
      ...SNAPSHOT,
      sessions: SNAPSHOT.sessions.map((session) =>
        session.id === 's1'
          ? { ...session, working: true, workingSince: minutesAgo(1) }
          : session
      )
    })
    render(
      <Shell
        port={port}
        workspace={createScriptedWorkspace()}
        commands={createScriptedCommands()}
        workflowRuns={createScriptedWorkflowRuns([])}
        monitors={createScriptedMonitors([monitorOf()])}
      />
    )
    await act(settled)

    const end = row(HERE).querySelector('.rowend')
    expect(end?.querySelector('.typing')).toBeTruthy()
    expect(end?.querySelector('.waiting')).toBeNull()
  })

  it('yields the slot to needs-you', async () => {
    const { port } = await shown([monitorOf({ sessionId: 's2' })])
    await act(async () => {
      await port.prompt('s2', 'go')
    })
    act(() => port.endTurn('s2'))
    await act(settled)

    const end = row(OTHER).querySelector('.rowend')
    expect(end?.querySelector('.pip')).toBeTruthy()
    expect(end?.querySelector('.waiting')).toBeNull()
  })

  it('lights no workspace roll-up dot: a wait is not work', async () => {
    await shown([monitorOf()])
    expect(document.querySelector('.ws.working')).toBeNull()
  })

  it('leaves a session with no monitors exactly as it was', async () => {
    await shown([monitorOf()])
    expect(row(OTHER).querySelector('.waiting')).toBeNull()
    expect(nameOf(OTHER)).toBe(OTHER)
  })
})

describe('a node\u2019s wait inside a run', () => {
  const waiting = runOf({
    nodes: [
      {
        id: 'implement',
        status: 'running',
        parents: [],
        reads: [],
        artifacts: [],
        startedAt: minutesAgo(18),
        waitingOn: {
          monitorId: 'm-node1',
          description: 'CI on PR #482 to finish',
          since: minutesAgo(4)
        }
      }
    ]
  })

  it('says what the node is waiting on, in the monitor\u2019s own words, on the run chip', async () => {
    await shown([], [waiting])
    const chip = document.querySelector('.runchip')
    expect(chip?.querySelector('.waiting')?.textContent).toBe(
      '⏳ CI on PR #482 to finish · 4m'
    )
  })

  it('puts no chip in the "Waiting on" group and no ⏳ on the row', async () => {
    await shown([], [waiting])
    expect(chips()).toHaveLength(0)
    expect(screen.queryByText('Waiting on')).toBeNull()
    expect(row(HERE).querySelector('.rowend .waiting')).toBeNull()
  })

  it('says the same thing in the same words in the run view’s node header', async () => {
    await shown([], [waiting])
    await act(async () => {
      fireEvent.click(document.querySelector('.runchip') as HTMLElement)
      await settled()
    })

    const header = document.querySelector('.detail .dhead')
    expect(header?.querySelector('.waiting')?.textContent).toBe(
      '⏳ CI on PR #482 to finish · 4m'
    )
  })

  it('offers the user no way to stop it', async () => {
    await shown([], [waiting])
    const chip = document.querySelector('.runchip')
    expect(within(chip as HTMLElement).queryByRole('button')).toBeNull()
    expect(document.querySelector('.runchip .x')).toBeNull()

    await act(async () => {
      fireEvent.click(document.querySelector('.runchip') as HTMLElement)
      await settled()
    })
    // Pause and Cancel stay a run's only mechanical controls: nothing in the
    // run view stops a node's wait either.
    const buttons = [...document.querySelectorAll('.runview button')].map(
      (button) => button.textContent ?? ''
    )
    expect(buttons.some((label) => /stop watching/i.test(label))).toBe(false)
  })
})

describe('what a wait does to the needs-you rules', () => {
  /** A whole turn in one session, start to finish. */
  async function turn(port: ScriptedPort, sessionId: string): Promise<void> {
    await act(async () => {
      await port.prompt(sessionId, 'go')
    })
    act(() => port.endTurn(sessionId))
    await act(settled)
  }

  it('marks nothing by itself, however long it waits', async () => {
    await shown([monitorOf({ sessionId: 's2' })])
    expect(nameOf(OTHER)).toBe(`${OTHER} (waiting)`)
    // No mark, no count, nothing for Tab to land on.
    expect(document.querySelector('.sessrow.asking')).toBeNull()
    act(() => {
      fireEvent.keyDown(document, { key: 'Tab' })
    })
    expect(document.querySelector('.sessrow.viewing .sess')?.getAttribute('aria-label')).toBe(
      HERE
    )
  })

  it('reaches neither the dock badge nor a notification', async () => {
    const counts: number[] = []
    const banners: unknown[] = []
    const port = createScriptedPort(SNAPSHOT)
    render(
      <Shell
        port={port}
        workspace={createScriptedWorkspace()}
        commands={createScriptedCommands()}
        workflowRuns={createScriptedWorkflowRuns([])}
        monitors={createScriptedMonitors([monitorOf({ sessionId: 's2' })])}
        needsYou={{
          async waiting(count: number) {
            counts.push(count)
          },
          async announce(session: unknown) {
            banners.push(session)
          }
        }}
      />
    )
    await act(settled)

    expect(counts.every((count) => count === 0)).toBe(true)
    expect(banners).toEqual([])
  })

  it('does not hush a turn ending in a session the user was not looking at', async () => {
    const { port } = await shown([monitorOf({ sessionId: 's2' })])
    await turn(port, 's2')
    // The wait is not work on the user's behalf, so the ordinary rule stands.
    expect(nameOf(OTHER)).toContain('needs you')
  })

  it('lets the turn a wake starts end like any other turn', async () => {
    const { port } = await shown([])
    await act(async () => {
      port.emit({ type: 'turn_started', sessionId: 's2', turnId: 't-7' })
      port.emit({
        type: 'user_message',
        sessionId: 's2',
        turnId: 't-7',
        text: '⏳ Crucible monitor m-1f3a — condition met: CI on PR #482 to finish',
        card: {
          badge: 'monitor',
          tone: 'monitor',
          title: 'CI on PR #482 to finish',
          meta: 'condition met · 6m 40s · 13 checks'
        }
      })
      port.emit({ type: 'turn_ended', sessionId: 's2', turnId: 't-7' })
      await settled()
    })
    expect(nameOf(OTHER)).toContain('needs you')
  })
})

describe('the wake in the transcript', () => {
  const card: SystemCard = {
    badge: 'monitor',
    tone: 'monitor',
    title: 'CI on PR #482 to finish',
    meta: 'condition met · 6m 40s · 13 checks',
    body: 'last output: completed · e2e: failure'
  }

  async function wake(tone: SystemCard['tone']): Promise<void> {
    const { port } = await shown([])
    await act(async () => {
      port.emit({ type: 'turn_started', sessionId: 's1', turnId: 't-9' })
      port.emit({
        type: 'user_message',
        sessionId: 's1',
        turnId: 't-9',
        text: '⏳ Crucible monitor m-1f3a — condition met: CI on PR #482 to finish',
        card: { ...card, tone }
      })
      await settled()
    })
  }

  it('is a system card, badged as a monitor, and never a user\u2019s bubble', async () => {
    await wake('monitor')
    const shownCard = document.querySelector('.syscard')
    expect(shownCard).toBeTruthy()
    expect(shownCard?.getAttribute('aria-label')).toBe('Crucible')
    expect(shownCard?.querySelector('.badge')?.textContent).toBe('monitor')
    expect(shownCard?.textContent).toContain('CI on PR #482 to finish')
    expect(shownCard?.textContent).toContain('condition met · 6m 40s · 13 checks')
    expect(shownCard?.textContent).toContain('last output: completed · e2e: failure')
    expect(document.querySelector('.msg.user')).toBeNull()
  })

  it('tells the three endings apart in its own appearance', async () => {
    await wake('warn')
    expect(document.querySelector('.syscard .card')?.getAttribute('data-tone')).toBe('warn')
  })

  it('leaves nothing else about the monitor in the transcript', async () => {
    const { monitorService } = await shown([monitorOf()])
    // A live monitor writes nothing into the chat: no card, no status line,
    // and nothing that updates while it waits.
    expect(document.querySelector('.chat .syscard')).toBeNull()
    await act(async () => {
      monitorService.setMonitors([
        monitorOf({
          checks: 9,
          last: {
            at: minutesAgo(0),
            output: { text: 'queued', truncated: false },
            result: { kind: 'exited', exitCode: 1 }
          }
        })
      ])
      await settled()
    })
    expect(document.querySelector('.chat .syscard')).toBeNull()
  })

  it('raises no dialog, no confirm and nothing the user has to answer', async () => {
    await wake('bad')
    expect(document.querySelector('.confirm')).toBeNull()
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  })
})
