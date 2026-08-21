// @vitest-environment jsdom
//
// The overlay region, driven through the shell. jsdom lays nothing out, so
// what is pinned is which elements exist, where they sit, and what a click or
// a key does to them — never a measurement.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import { createFakeCacheService, fakeCacheHealth } from '../../shared/cache/fake-service'
import type { RunRecord } from '../../shared/workflows/run'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkflowRuns } from './testing/scripted-workflow-runs'
import { createScriptedWorkspace, type ScriptedWorkspace } from './testing/scripted-workspace'
import { hostedBoard } from './testing/boards'
import { hostedIssues } from './testing/issues'
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
      createdAt: '2026-08-21T10:00:00.000Z',
      title: 'overlay region pass',
      working: false,
      fresh: false
    },
    {
      id: 's2',
      workspaceId: 'w1',
      createdAt: '2026-08-21T10:01:00.000Z',
      title: 'composer growth',
      working: false,
      fresh: false
    }
  ]
}

const RUN: RunRecord = {
  id: 'en7',
  workflow: 'build',
  status: 'running',
  workspacePath: '/repos/crucible',
  workspaceName: 'crucible',
  sessionId: 's1',
  worktreePath: '/repos/crucible/.crucible/worktrees/run-en7',
  branch: 'crucible/run-en7',
  baseCommit: 'abc1234',
  createdAt: '2026-08-21T09:59:00.000Z',
  inputs: {},
  nodes: [
    {
      id: 'planner',
      status: 'complete',
      parents: [],
      model: 'anthropic/claude-fable-5:high',
      reads: [],
      artifacts: [],
      summary: 'wrote the spec',
      cost: 0.2,
      startedAt: '2026-08-21T10:00:00.000Z',
      endedAt: '2026-08-21T10:02:00.000Z'
    }
  ],
  startedAt: '2026-08-21T10:00:00.000Z'
}

interface Shelf {
  readonly port: ScriptedPort
  readonly workspace: ScriptedWorkspace
}

async function shell(options: { readonly conversation?: boolean } = {}): Promise<Shelf> {
  const port = createScriptedPort(SNAPSHOT)
  port.models = [{ id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off'] }]
  port.trees.set('s1', { roots: [], path: [] })
  // A conversation with something in it, so a reset asks before it acts.
  if (options.conversation === true) {
    port.transcripts.set('s1', [{ kind: 'user', text: 'something to lose' }])
  }
  const workspace = createScriptedWorkspace()
  workspace.boards.set('/repos/crucible', { kind: 'board', board: hostedBoard() })
  workspace.issues.set('/repos/crucible', { kind: 'board', board: hostedIssues() })
  render(
    <Shell
      port={port}
      workspace={workspace}
      commands={createScriptedCommands()}
      cache={createFakeCacheService(fakeCacheHealth({ count: 4, dollars: 1.1 }))}
      workflowRuns={createScriptedWorkflowRuns([RUN])}
    />
  )
  await settled()
  return { port, workspace }
}

const region = (): HTMLElement | null => document.querySelector('.region')

async function click(name: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
  await settled()
}

async function press(key: string, options: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(document, { key, ...options })
  })
  await settled()
}

/** Double-Esc, the session tree's only way in. */
async function doubleEscape(): Promise<void> {
  await press('Escape')
  await press('Escape')
}

// Every occupant of the region, by the accessible name its surface answers
// to and the way in the user actually has.
const OCCUPANTS: readonly {
  readonly name: string
  readonly surface: string
  readonly role: string
  readonly open: () => Promise<void>
}[] = [
  {
    name: 'the branch board',
    surface: 'Branch board',
    role: 'dialog',
    open: () => click('Branch board')
  },
  {
    name: 'the issue board',
    surface: 'Issue board',
    role: 'dialog',
    open: () => click('Issue board')
  },
  {
    name: 'the session tree',
    surface: 'Session tree',
    role: 'dialog',
    open: doubleEscape
  },
  {
    name: 'Settings',
    surface: 'Settings',
    role: 'dialog',
    open: () => click('Settings')
  },
  {
    name: 'the runs overview',
    surface: 'All runs',
    role: 'region',
    open: () => press('r', { metaKey: true })
  },
  {
    name: 'the cache health view',
    surface: 'Cache health',
    role: 'dialog',
    open: () => click(/cache/i)
  },
  {
    name: 'the resume palette',
    surface: 'Resume session',
    role: 'dialog',
    open: () => click('Resume session…')
  }
]

describe('where an overlay renders', () => {
  for (const occupant of OCCUPANTS) {
    it(`puts ${occupant.name} inside the one region host`, async () => {
      await shell()

      await occupant.open()

      const surface = screen.getByRole(occupant.role, { name: occupant.surface })
      expect(surface.closest('.region')).toBe(region())
      expect(document.querySelectorAll('.region')).toHaveLength(1)
    })

    it(`leaves the sidebar and the bar row uncovered under ${occupant.name}`, async () => {
      await shell()

      await occupant.open()

      // The region is a sibling of the chat column and the context panel, and
      // the sidebar is outside the box it lives in altogether.
      expect(document.querySelector('.region nav.side')).toBeNull()
      expect(document.querySelector('.region header.top')).toBeNull()
      expect(document.querySelector('.region .tabstrip')).toBeNull()
      expect(document.querySelector('.main > header.top')).not.toBeNull()
      expect(
        screen.getByRole('navigation', { name: 'Workspaces and sessions' })
      ).toBeInTheDocument()
    })
  }

  it('is not there at all when nothing occupies it', async () => {
    await shell()

    expect(region()).toBeNull()
  })

  it('covers the composer, which is why the tree no longer sits in the chat', async () => {
    await shell()

    await doubleEscape()

    expect(screen.getByRole('dialog', { name: 'Session tree' })).toBeInTheDocument()
    // The composer is outside the region, under it.
    expect(document.querySelector('.region .composer')).toBeNull()
    expect(document.querySelector('.main .composer')).not.toBeNull()
  })
})

describe('one occupant at a time', () => {
  it('replaces Settings with the branch board, and the board with Settings', async () => {
    await shell()
    await click('Settings')

    await click('Branch board')

    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Branch board' })).toBeInTheDocument()

    await click('Settings')

    expect(screen.queryByRole('dialog', { name: 'Branch board' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
  })

  it('replaces the branch board with the session tree', async () => {
    await shell()
    await click('Branch board')

    // The board takes Escape's first press, so the tree's accelerator only
    // starts counting once the region is empty again.
    await press('Escape')
    await doubleEscape()

    expect(screen.queryByRole('dialog', { name: 'Branch board' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Session tree' })).toBeInTheDocument()
  })

  it('replaces whatever is up with the resume palette, and the palette with a board', async () => {
    await shell()
    await click('Issue board')

    await click('Resume session…')

    expect(screen.queryByRole('dialog', { name: 'Issue board' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Resume session' })).toBeInTheDocument()

    await click('Issue board')

    expect(screen.queryByRole('dialog', { name: 'Resume session' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Issue board' })).toBeInTheDocument()
  })

  it('keeps the runs overview out of the region once something else takes it', async () => {
    await shell()
    await press('r', { metaKey: true })

    await click('Settings')

    expect(screen.queryByLabelText('All runs')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
  })

  it('never renders one overlay underneath another', async () => {
    await shell()
    await click('Branch board')
    await click('Settings')

    expect(document.querySelectorAll('.region > *')).toHaveLength(1)
  })

  it('keeps the sanctioned stack: an opened run above the overview', async () => {
    await shell()
    await press('r', { metaKey: true })

    await click('Open run')

    expect(screen.getByLabelText('Run en7')).toBeInTheDocument()
    expect(screen.getByLabelText('All runs')).toBeInTheDocument()

    // Esc unwinds one surface, landing back on the overview it came from.
    await press('Escape')

    expect(screen.queryByLabelText('Run en7')).toBeNull()
    expect(screen.getByLabelText('All runs')).toBeInTheDocument()
  })
})

describe('the sidebar under an open overlay (Q2)', () => {
  for (const occupant of OCCUPANTS) {
    it(`lands a session click and closes ${occupant.name}`, async () => {
      const { port } = await shell()
      await occupant.open()

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'composer growth' }))
      })
      await settled()

      expect(screen.queryByRole(occupant.role, { name: occupant.surface })).toBeNull()
      expect(region()).toBeNull()
      expect(port.calls).toContainEqual({ op: 'activateSession', args: ['s2'] })
    })

    it(`lands a workspace click and closes ${occupant.name}`, async () => {
      const { port } = await shell()
      await occupant.open()

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'resume-site' }))
      })
      await settled()

      expect(screen.queryByRole(occupant.role, { name: occupant.surface })).toBeNull()
      expect(port.calls).toContainEqual({ op: 'activateWorkspace', args: ['w2'] })
    })
  }

  it('creates, activates and closes the occupant on New session', async () => {
    const { port } = await shell()
    await click('Settings')

    await click('New session')

    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
    expect(port.calls.map((call) => call.op)).toContain('createSession')
  })

  it('closes the occupant when a removal changes the active session', async () => {
    const { port } = await shell()
    await click('Branch board')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove overlay region pass' }))
    })
    await settled()

    expect(screen.queryByRole('dialog', { name: 'Branch board' })).toBeNull()
    expect(port.calls).toContainEqual({ op: 'removeSession', args: ['s1'] })
  })

  // A confirm must not survive the navigation: left up, its copy ("Reset this
  // session?") reads as being about the session now on screen while its
  // confirm button still acts on the one navigated away from.
  it('does not leave a confirm dialog up over the session a click landed on', async () => {
    const { port } = await shell({ conversation: true })
    await click('Session menu')
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Reset session' }))
    })
    await settled()
    expect(screen.getByRole('dialog', { name: 'Reset this session?' })).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'composer growth' }))
    })
    await settled()

    // The click landed…
    expect(port.calls).toContainEqual({ op: 'activateSession', args: ['s2'] })
    // …and nothing modal about the previous session is still up over its chat.
    expect(screen.queryByRole('dialog', { name: 'Reset this session?' })).toBeNull()
    expect(region()).toBeNull()
  })

  // The same rule reached by the other navigation: a workspace switch changes
  // the active session too, so the confirm goes with the chat it was about.
  it('drops a confirm when a workspace switch takes its session off screen', async () => {
    const { port } = await shell({ conversation: true })
    await click('Session menu')
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Reset session' }))
    })
    await settled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'resume-site' }))
    })
    await settled()

    expect(port.calls).toContainEqual({ op: 'activateWorkspace', args: ['w2'] })
    expect(screen.queryByRole('dialog', { name: 'Reset this session?' })).toBeNull()
    expect(region()).toBeNull()
  })

  // The other side of that rule. ⌘B under a live confirm swaps the occupant
  // beneath it and navigates nowhere, so the confirm is still about the
  // session on screen.
  it('keeps a confirm up when an overlay opens beneath it', async () => {
    await shell({ conversation: true })
    await click('Session menu')
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Reset session' }))
    })
    await settled()

    await press('b', { metaKey: true })

    expect(screen.getByRole('dialog', { name: 'Branch board' })).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Reset this session?' })).toBeInTheDocument()
  })

  it('leaves the occupant alone when the removal is of another session', async () => {
    await shell()
    await click('Branch board')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove composer growth' }))
    })
    await settled()

    expect(screen.getByRole('dialog', { name: 'Branch board' })).toBeInTheDocument()
  })
})

describe('the bar row under an open overlay', () => {
  it('lets a top-bar chip replace the occupant', async () => {
    await shell()
    await click('Settings')

    await click('Issue board')

    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Issue board' })).toBeInTheDocument()
  })

  it('keeps the cost chip working, landing on Usage', async () => {
    await shell()
    await click('Branch board')

    await click('Session cost')

    expect(screen.queryByRole('dialog', { name: 'Branch board' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Usage' })).toHaveAttribute('aria-current', 'true')
  })

  it('still opens the session menu over the region', async () => {
    await shell()
    await click('Branch board')

    await click('Session menu')

    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Branch board' })).toBeInTheDocument()
  })
})

describe('Escape precedence', () => {
  it('answers a confirm dialog before the occupant it was raised over', async () => {
    await shell({ conversation: true })
    await click('Branch board')
    await click('Session menu')
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Reset session' }))
    })
    await settled()

    expect(screen.getByRole('dialog', { name: 'Reset this session?' })).toBeInTheDocument()
    // Stacked above, not instead of: the board is still up behind it.
    expect(screen.getByRole('dialog', { name: 'Branch board' })).toBeInTheDocument()

    await press('Escape')

    expect(screen.queryByRole('dialog', { name: 'Reset this session?' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Branch board' })).toBeInTheDocument()

    await press('Escape')

    expect(region()).toBeNull()
  })

  it('never cancels a turn while the region is occupied', async () => {
    const { port } = await shell()
    await click('Branch board')
    await act(async () => {
      await port.prompt('s1', 'go')
    })
    await settled()

    await press('Escape')

    expect(screen.queryByRole('dialog', { name: 'Branch board' })).toBeNull()
    expect(port.calls.map((call) => call.op)).not.toContain('cancel')

    // With the region empty again, Escape means stop.
    await press('Escape')
    expect(port.calls.map((call) => call.op)).toContain('cancel')
  })
})

describe('the small dialogs and the palette', () => {
  it('centres the confirm dialog in the region rather than veiling the window', async () => {
    await shell({ conversation: true })
    await click('Session menu')
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Reset session' }))
    })
    await settled()

    const dialog = screen.getByRole('dialog', { name: 'Reset this session?' })
    expect(dialog.closest('.region')).toBe(region())
  })

  it('centres the cache health view and the palette there too', async () => {
    await shell()

    await click(/cache/i)
    expect(screen.getByRole('dialog', { name: 'Cache health' }).closest('.region')).toBe(region())

    await click('Resume session…')
    expect(screen.getByRole('dialog', { name: 'Resume session' }).closest('.region')).toBe(
      region()
    )
  })
})
