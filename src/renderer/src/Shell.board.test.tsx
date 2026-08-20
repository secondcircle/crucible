// @vitest-environment jsdom
//
// What the branch board shows: the resting chip, the sidebar badges, the
// overlay and its two variants. Nothing here is backed by anything but the
// snapshot the workspace service answered with.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort, oneSession } from './testing/scripted-port'
import { createScriptedWorkspace, type ScriptedWorkspace } from './testing/scripted-workspace'
import { gitOnlyBoard, hostedBoard, unreachableBoard } from './testing/boards'
import { settled } from './testing/settled'

const NOW = '2026-08-19T14:14:00.000Z'

const TWO_WORKSPACES: Partial<ShellSnapshot> = {
  workspaces: [
    { id: 'w1', name: 'crucible', path: '/repos/crucible' },
    { id: 'w2', name: 'resume-site', path: '/repos/resume-site' }
  ],
  activeWorkspaceId: 'w1',
  sessions: [{ id: 's1', workspaceId: 'w1', createdAt: NOW, working: false }],
  activeSessionId: 's1'
}

async function shell(
  set: (workspace: ScriptedWorkspace) => void = () => {},
  snapshot: Partial<ShellSnapshot> = oneSession()
): Promise<ScriptedWorkspace> {
  const port = createScriptedPort(snapshot)
  const workspace = createScriptedWorkspace()
  set(workspace)
  render(
    <Shell port={port} workspace={workspace} commands={createScriptedCommands()} />
  )
  await settled()
  return workspace
}

/** The one workspace of `oneSession`, answering with the work repository. */
async function hosted(): Promise<ScriptedWorkspace> {
  return shell((workspace) => {
    workspace.boards.set('/repos/crucible', { kind: 'board', board: hostedBoard() })
  })
}

const chip = (): HTMLElement | null => screen.queryByRole('button', { name: 'Branch board' })

const board = (): HTMLElement | null => screen.queryByRole('dialog', { name: 'Branch board' })

const rows = (): string[] =>
  screen.queryAllByRole('option').map((row) => row.getAttribute('aria-label') ?? '')

const headings = (): string[] =>
  Array.from(document.querySelectorAll('.ghead h2')).map((head) => head.textContent ?? '')

async function open(): Promise<void> {
  await act(async () => {
    fireEvent.click(chip() as HTMLElement)
  })
}

async function press(key: string, options: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(document, { key, ...options })
  })
}

describe('the chip in the resting top bar', () => {
  it('is absent until a collection has answered with a board', async () => {
    await shell((workspace) => {
      workspace.holdBoard = true
      workspace.boards.set('/repos/crucible', { kind: 'board', board: hostedBoard() })
    })

    expect(chip()).toBeNull()
  })

  it('is absent for a folder that is not a repository', async () => {
    await shell()

    expect(chip()).toBeNull()
  })

  it('counts your landed branches and what needs you, and lights up for it', async () => {
    await hosted()

    // Two landed branches of yours; failing checks, changes requested, and a
    // review requested of you.
    expect(chip()).toHaveTextContent('2 landed · 3 need you')
    expect(chip()?.className).toContain('lit')
  })

  it('says nothing about needing you when nothing does, and stays unlit', async () => {
    await shell((workspace) => {
      workspace.boards.set('/repos/crucible', { kind: 'board', board: gitOnlyBoard() })
    })

    expect(chip()).toHaveTextContent('1 landed')
    expect(chip()).not.toHaveTextContent('need you')
    expect(chip()?.className).not.toContain('lit')
  })
})

describe('the sidebar badge', () => {
  it('shows each workspace its own number, and hides it at zero', async () => {
    await shell((workspace) => {
      workspace.boards.set('/repos/crucible', { kind: 'board', board: hostedBoard() })
      workspace.boards.set('/repos/resume-site', { kind: 'board', board: gitOnlyBoard() })
    }, TWO_WORKSPACES)

    // The poll sweeps every workspace in the sidebar when the window is
    // focused, which is how a background board is ever collected at all.
    await act(async () => {
      fireEvent.focus(window)
    })
    await settled()

    expect(screen.getByTitle('3 need you in crucible')).toHaveTextContent('3')
    // The home repository has nothing asking for anybody.
    expect(screen.queryByTitle(/need you in resume-site/)).toBeNull()
  })
})

describe('opening and closing the board', () => {
  it('opens from the chip and closes on Escape', async () => {
    await hosted()

    await open()
    expect(board()).not.toBeNull()

    await press('Escape')
    expect(board()).toBeNull()
  })

  it('toggles on ⌘B', async () => {
    await hosted()

    await press('b', { metaKey: true })
    expect(board()).not.toBeNull()

    await press('b', { metaKey: true })
    expect(board()).toBeNull()
  })

  it('says it is reading while the first collection is still under way', async () => {
    const workspace = await shell((scripted) => {
      scripted.holdBoard = true
      scripted.boards.set('/repos/crucible', { kind: 'board', board: hostedBoard() })
    })

    // No chip yet, so ⌘B is the only way in, and it opens in the same frame.
    await press('b', { metaKey: true })

    expect(board()).not.toBeNull()
    expect(screen.getByText('Reading branches…')).toBeInTheDocument()
    // Nothing is invented for a board that has not answered.
    expect(document.querySelector('.bhead .repo')).toBeNull()
    expect(rows()).toEqual([])

    await act(async () => {
      workspace.settleBoard()
    })
    await settled()

    expect(screen.queryByText('Reading branches…')).toBeNull()
    expect(rows()).toContain('issue-7-roster-parking')
  })

  it('does nothing on ⌘B where there is no repository to report on', async () => {
    await shell()

    await press('b', { metaKey: true })

    expect(board()).toBeNull()
  })

  it('opens and works with no session open at all', async () => {
    await shell(
      (workspace) => {
        workspace.boards.set('/repos/crucible', { kind: 'board', board: hostedBoard() })
      },
      { workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }], activeWorkspaceId: 'w1', sessions: [] }
    )

    await open()

    expect(board()).not.toBeNull()
    expect(rows()).toContain('issue-7-roster-parking')
  })

  it('closes when the active workspace changes, because it belongs to one', async () => {
    const workspace = await shell((scripted) => {
      scripted.boards.set('/repos/crucible', { kind: 'board', board: hostedBoard() })
      scripted.boards.set('/repos/resume-site', { kind: 'board', board: gitOnlyBoard() })
    }, TWO_WORKSPACES)
    await open()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'resume-site' }))
    })

    expect(board()).toBeNull()
    // And the workspace switched to is collected for, so its chip is honest.
    expect(workspace.calls).toContainEqual({ op: 'branchBoard', args: ['/repos/resume-site'] })
  })

  it('stays closed when the workspace it was opened for becomes active again', async () => {
    await shell((scripted) => {
      scripted.boards.set('/repos/crucible', { kind: 'board', board: hostedBoard() })
      scripted.boards.set('/repos/resume-site', { kind: 'board', board: gitOnlyBoard() })
    }, TWO_WORKSPACES)
    await open()

    // Switching away closes the board, and only the chip and ⌘B open it, so
    // switching back must not.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'resume-site' }))
    })
    expect(board()).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'crucible' }))
    })

    expect(board()).toBeNull()
  })

  it('stays closed when a folder that stopped being a repository becomes one again', async () => {
    const workspace = await hosted()
    await open()

    // The same close, reached the other way: the answer says there is no
    // repository here, so there is no board to show.
    workspace.boards.set('/repos/crucible', { kind: 'noRepository' })
    await act(async () => {
      fireEvent.focus(window)
    })
    await settled()
    expect(board()).toBeNull()

    workspace.boards.set('/repos/crucible', { kind: 'board', board: hostedBoard() })
    await act(async () => {
      fireEvent.focus(window)
    })
    await settled()

    expect(board()).toBeNull()
    // And the chip is back, which is what the user opens it with.
    expect(chip()).not.toBeNull()
  })

  it('closes before the session tree, and never cancels a running turn', async () => {
    const port = createScriptedPort(oneSession())
    const workspace = createScriptedWorkspace()
    workspace.boards.set('/repos/crucible', { kind: 'board', board: hostedBoard() })
    render(<Shell port={port} workspace={workspace} commands={createScriptedCommands()} />)
    await settled()
    await open()

    // The turn starts under the open board, which is where Escape's precedence
    // actually matters.
    await act(async () => {
      await port.prompt('s1', 'go')
    })
    await press('Escape')

    expect(board()).toBeNull()
    // Escape spent itself on the board: the turn is untouched.
    expect(port.calls.map((call) => call.op)).not.toContain('cancel')
  })
})

describe('what the hosted board shows', () => {
  it('names the repository, the trunk and the host', async () => {
    await hosted()
    await open()

    expect(document.querySelector('.bhead .repo')?.textContent).toBe(
      'secondcircle/pi-extensions · trunk main · GitHub'
    )
    expect(screen.getByText(/refreshed 0s ago/)).toBeInTheDocument()
  })

  it('draws every group that has rows, in the one order, with its why', async () => {
    await hosted()
    await open()

    expect(headings()).toEqual([
      'Landed',
      'In flight',
      'Waiting on you',
      'Local only',
      'Stale'
    ])
    expect(
      screen.getByText(
        'their PR merged, or their commits are in main — nothing here holds unique work'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('open PRs of yours, and pushed work without one')).toBeInTheDocument()
    expect(
      screen.getByText(
        "someone else's PR that names you as reviewer or assignee — no branch in this clone"
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText('never pushed — this clone is the only copy that exists')
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'untouched over 30 days and never landed — listed, never counted, never touched'
      )
    ).toBeInTheDocument()
  })

  it('omits a group with nothing in it rather than showing it empty', async () => {
    await shell((workspace) => {
      workspace.boards.set('/repos/crucible', {
        kind: 'board',
        board: { ...hostedBoard(), rows: hostedBoard().rows.filter((row) => row.group === 'stale') }
      })
    })
    await open()

    expect(headings()).toEqual(['Stale'])
  })

  it('renders each cell of a row from the snapshot and nothing else', async () => {
    await hosted()
    await open()
    const row = screen.getByRole('option', { name: 'issue-9-id-namespacing' })

    expect(within(row).getByText('checked out')).toBeInTheDocument()
    expect(within(row).getByText("a lead's workers are numbered under its own id")).toBeInTheDocument()
    expect(row.querySelector('.drift')?.textContent).toBe('1 ahead · 93 behind')
    expect(row.querySelector('.age')?.textContent).toBe('2d')
    expect(within(row).getByText('✕ 2 checks failed')).toBeInTheDocument()
    expect(within(row).getByText('#54')).toBeInTheDocument()
    expect(within(row).getByText('open')).toBeInTheDocument()
    // Present locally and on origin, and the pills say which.
    expect(Array.from(row.querySelectorAll('.where i.on')).map((pill) => pill.textContent)).toEqual([
      'local',
      'origin'
    ])
  })

  it('says why a landed row is landed, squashed or in the trunk', async () => {
    await hosted()
    await open()
    const squashed = screen.getByRole('option', { name: 'issue-7-roster-parking' })
    const ancestor = screen.getByRole('option', { name: 'build/build-260819-f1wn' })

    expect(squashed.querySelector('.drift')?.textContent).toBe('squashed')
    expect(within(squashed).getByText('merged by you')).toBeInTheDocument()
    expect(within(squashed).getByText('merged')).toBeInTheDocument()

    expect(ancestor.querySelector('.drift')?.textContent).toBe('0 ahead')
    expect(within(ancestor).getByText("in main's history")).toBeInTheDocument()
    // No pull request anywhere, and the cell says so rather than pretending.
    expect(within(ancestor).getByText('no PR')).toBeInTheDocument()
  })

  it('shows a waiting row as somebody else\u2019s work that names you', async () => {
    await hosted()
    await open()
    const review = screen.getByRole('option', { name: 'tam/retry-budget-guard' })
    const assigned = screen.getByRole('option', { name: 'bot/deps-bump-aug' })

    expect(review.querySelector('.drift')?.textContent).toBe('by tamsin')
    expect(within(review).getByText('your review')).toBeInTheDocument()
    expect(within(assigned).getByText('assigned to you')).toBeInTheDocument()
  })

  it('orders the rows in a group most recently touched first', async () => {
    // Handed over oldest first, which is not how a board reads.
    await shell((workspace) => {
      const board = hostedBoard()
      workspace.boards.set('/repos/crucible', {
        kind: 'board',
        board: { ...board, rows: [...board.rows].reverse() }
      })
    })
    await open()

    expect(rows().slice(0, 2)).toEqual(['build/build-260819-f1wn', 'issue-7-roster-parking'])
    expect(headings()).toEqual([
      'Landed',
      'In flight',
      'Waiting on you',
      'Local only',
      'Stale'
    ])
  })

  it('lists what it can do, and that it deletes nothing', async () => {
    await hosted()
    await open()
    const footer = document.querySelector('.bfoot')?.textContent ?? ''

    expect(footer).toContain('⏎ open PR in browser')
    expect(footer).toContain('⌘C copy branch name')
    expect(footer).toContain('git + GitHub via gh · nothing here is deleted for you')
  })
})

describe('a board with no host', () => {
  it('renders no signal or pull-request track at all', async () => {
    await shell((workspace) => {
      workspace.boards.set('/repos/crucible', { kind: 'board', board: gitOnlyBoard() })
    })
    await open()
    const row = screen.getByRole('option', { name: 'og-image' })

    expect(row.className).toContain('nohost')
    expect(row.querySelector('.signal')).toBeNull()
    expect(row.querySelector('.pr')).toBeNull()
    expect(screen.queryByText('no PR')).toBeNull()
  })

  it('has no Waiting on you group, and says the trunk in its own words', async () => {
    await shell((workspace) => {
      workspace.boards.set('/repos/crucible', { kind: 'board', board: gitOnlyBoard() })
    })
    await open()

    expect(headings()).toEqual(['Landed', 'In flight', 'Local only'])
    expect(screen.getByText('their commits are in main')).toBeInTheDocument()
    expect(screen.getByText('pushed and not yet in main')).toBeInTheDocument()
    expect(document.querySelector('.bhead .repo')?.textContent).toBe(
      '/repos/resume-site · trunk main · no host connected'
    )
    expect(document.querySelector('.bfoot')?.textContent).toContain(
      'git only · nothing here is deleted for you'
    )
    // Nothing about opening a pull request there is nowhere to open.
    expect(document.querySelector('.bfoot')?.textContent).not.toContain('open PR')
  })

  it('says so when the host is there but could not answer', async () => {
    await shell((workspace) => {
      workspace.boards.set('/repos/crucible', { kind: 'board', board: unreachableBoard() })
    })
    await open()

    expect(document.querySelector('.bhead .repo')?.textContent).toBe(
      '/repos/pi-extensions · trunk main · GitHub unreachable — showing git only'
    )
    expect(screen.getByRole('option', { name: 'og-image' }).className).toContain('nohost')
  })

  it('shows a repository with nothing but its trunk in one quiet line', async () => {
    await shell((workspace) => {
      workspace.boards.set('/repos/crucible', {
        kind: 'board',
        board: { ...gitOnlyBoard(), rows: [] }
      })
    })
    await open()

    expect(screen.getByText('Nothing here but main.')).toBeInTheDocument()
  })
})

describe('whose branches are shown', () => {
  it('shows yours by default, and everyone else\u2019s pull requests that name you', async () => {
    await hosted()
    await open()

    expect(screen.getByText('yours only')).toBeInTheDocument()
    expect(rows()).not.toContain('plan/plan-20260410-ueno')
    // A review request is yours to answer whoever wrote it.
    expect(rows()).toContain('tam/retry-budget-guard')
  })

  it('widens in place when the link is clicked, and drops the link', async () => {
    await hosted()
    await open()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: "show everyone's" }))
    })

    expect(rows()).toContain('plan/plan-20260410-ueno')
    expect(screen.getByText('all branches')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: "show everyone's" })).toBeNull()
  })

  it('goes back to yours only the next time the board opens', async () => {
    await hosted()
    await open()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: "show everyone's" }))
    })

    await press('Escape')
    await open()

    expect(screen.getByText('yours only')).toBeInTheDocument()
    expect(rows()).not.toContain('plan/plan-20260410-ueno')
  })

  it('offers the widening on a git-only board too', async () => {
    await shell((workspace) => {
      workspace.boards.set('/repos/crucible', { kind: 'board', board: gitOnlyBoard() })
    })
    await open()

    expect(screen.getByText('yours only')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: "show everyone's" })).toBeInTheDocument()
  })
})
