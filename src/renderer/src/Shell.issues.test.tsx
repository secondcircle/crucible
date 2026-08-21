// @vitest-environment jsdom
//
// The issue board: the resting chip, the overlay, the reading pane, and the
// one click that starts aligned work on a ticket. Nothing here is backed by
// anything but the snapshot the workspace service answered with.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace, type ScriptedWorkspace } from './testing/scripted-workspace'
import { hostedIssues, jiraIssues } from './testing/issues'
import { settled } from './testing/settled'

interface Shelf {
  readonly port: ScriptedPort
  readonly workspace: ScriptedWorkspace
}

async function shell(
  set: (workspace: ScriptedWorkspace) => void = () => {},
  snapshot: Partial<ShellSnapshot> = oneSession()
): Promise<Shelf> {
  const port = createScriptedPort(snapshot)
  const workspace = createScriptedWorkspace()
  set(workspace)
  render(<Shell port={port} workspace={workspace} commands={createScriptedCommands()} />)
  await settled()
  return { port, workspace }
}

/** The one workspace of `oneSession`, answering with a board of issues. */
async function hosted(snapshot: Partial<ShellSnapshot> = oneSession()): Promise<Shelf> {
  return shell((workspace) => {
    workspace.issues.set('/repos/crucible', { kind: 'board', board: hostedIssues() })
  }, snapshot)
}

const chip = (): HTMLElement | null => screen.queryByRole('button', { name: 'Issue board' })

const board = (): HTMLElement | null => screen.queryByRole('dialog', { name: 'Issue board' })

const rows = (): string[] =>
  screen.queryAllByRole('option').map((row) => row.getAttribute('aria-label') ?? '')

const headings = (): string[] =>
  Array.from(document.querySelectorAll('.issues .ghead h2')).map((head) => head.textContent ?? '')

const pane = (): HTMLElement => screen.getByRole('complementary', { name: 'Issue' })

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

async function click(name: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

describe('the chip in the resting top bar', () => {
  it('is absent until a collection has answered with a board', async () => {
    await shell((workspace) => {
      workspace.holdIssues = true
      workspace.issues.set('/repos/crucible', { kind: 'board', board: hostedIssues() })
    })

    expect(chip()).toBeNull()
  })

  it('is absent for a workspace with no issue host', async () => {
    await shell()

    expect(chip()).toBeNull()
  })

  it('counts the open issues and the ones assigned to you, and lights for them', async () => {
    await hosted()

    expect(chip()).toHaveTextContent('6 issues · 2 yours')
    expect(chip()?.className).toContain('lit')
  })

  it('stays unlit where nothing is assigned to you', async () => {
    const board = hostedIssues()
    await shell((workspace) => {
      workspace.issues.set('/repos/crucible', {
        kind: 'board',
        board: { ...board, rows: board.rows.filter((row) => row.group !== 'assignedToYou') }
      })
    })

    expect(chip()).toHaveTextContent('4 issues')
    expect(chip()).not.toHaveTextContent('yours')
    expect(chip()?.className).not.toContain('lit')
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

  it('toggles on ⌘I', async () => {
    await hosted()

    await press('i', { metaKey: true })
    expect(board()).not.toBeNull()

    await press('i', { metaKey: true })
    expect(board()).toBeNull()
  })

  it('does nothing on ⌘I where the workspace has no issue host', async () => {
    await shell()

    await press('i', { metaKey: true })

    expect(board()).toBeNull()
  })

  it('says it is reading while the first collection is still under way', async () => {
    const { workspace } = await shell((scripted) => {
      scripted.holdIssues = true
      scripted.issues.set('/repos/crucible', { kind: 'board', board: hostedIssues() })
    })

    // No chip yet, so ⌘I is the only way in, and it opens in the same frame.
    await press('i', { metaKey: true })

    expect(board()).not.toBeNull()
    expect(screen.getByText('Reading issues…')).toBeInTheDocument()
    expect(rows()).toEqual([])

    await act(async () => {
      workspace.settleIssues()
    })
    await settled()

    expect(rows()).toContain('crucible#128')
  })

  it('replaces the branch board rather than stacking on it', async () => {
    await shell((workspace) => {
      workspace.issues.set('/repos/crucible', { kind: 'board', board: hostedIssues() })
      workspace.boards.set('/repos/crucible', { kind: 'noRepository' })
    })

    await press('i', { metaKey: true })

    expect(board()).not.toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Branch board' })).toBeNull()
  })
})

describe('a host that could not answer', () => {
  it('says so plainly instead of showing a board with no issues on it', async () => {
    await shell((workspace) => {
      workspace.issues.set('/repos/crucible', {
        kind: 'unreachable',
        reason: 'gh: command not found'
      })
    })

    // No chip: nothing was counted, so nothing may be shown as a count.
    expect(chip()).toBeNull()

    await press('i', { metaKey: true })

    expect(screen.getByRole('alert')).toHaveTextContent('gh: command not found')
    expect(rows()).toEqual([])
  })
})

describe('what the board shows', () => {
  it('opens on yours and unclaimed, with what is taken grouped at the bottom', async () => {
    await hosted()
    await open()

    expect(headings()).toEqual([
      'Assigned to you',
      'Mentions you',
      'Unclaimed',
      'Already picked up'
    ])
    expect(rows()).toEqual([
      'crucible#128',
      'crucible#131',
      'crucible#124',
      'crucible#133',
      'crucible#117'
    ])
  })

  it("widens to everyone's in one click, and back again", async () => {
    await hosted()
    await open()

    await click("show everyone's")
    expect(headings()).toContain('Assigned to others')
    expect(rows()).toContain('crucible#134')

    await click('show yours only')
    expect(rows()).not.toContain('crucible#134')
  })

  it('says why every row in a group is in it', async () => {
    await hosted()
    await open()

    expect(screen.getByText('open, nobody assigned — free to pick up')).toBeInTheDocument()
    expect(
      screen.getByText('a session here started on it, or a pull request names it')
    ).toBeInTheDocument()
  })

  it('says what already picked an issue up', async () => {
    await hosted()
    await open()

    const taken = screen.getByRole('option', { name: 'crucible#117' })
    expect(taken).toHaveTextContent('PR #130 open')
  })

  it('dates itself, and says which host it read', async () => {
    await hosted()
    await open()

    expect(screen.getByText(/refreshed 0s ago/)).toBeInTheDocument()
    expect(document.querySelector('.bhead .repo')?.textContent).toBe(
      'secondcircle/crucible · GitHub Issues'
    )
  })
})

describe('the reading pane', () => {
  it('opens on the first row, body, labels and latest comment and all', async () => {
    await hosted()
    await open()

    expect(within(pane()).getByRole('heading', { level: 3 })).toHaveTextContent(
      'Quota strip misaligns under the Add workspace button'
    )
    expect(within(pane()).getByText(/At 248px sidebar width/)).toBeInTheDocument()
    expect(within(pane()).getByText('Reproduced on Max.')).toBeInTheDocument()
    // Three comments, one of them shown.
    expect(within(pane()).getByText(/2 more comments/)).toBeInTheDocument()
  })

  it('follows the arrows down the list', async () => {
    await hosted()
    await open()

    await press('ArrowDown')

    expect(within(pane()).getByRole('heading', { level: 3 })).toHaveTextContent(
      'Session tree: jumping from a tool chain loses the collapse state'
    )
  })

  it('follows a click on a row, which does nothing else at all', async () => {
    const { port } = await hosted()
    await open()

    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'crucible#133' }))
    })

    expect(within(pane()).getByRole('heading', { level: 3 })).toHaveTextContent(
      'Bash run output should keep ANSI colour in the conversation'
    )
    expect(port.calls.some((call) => call.op === 'createSession')).toBe(false)
  })

  it('says an issue has no description rather than showing an empty pane', async () => {
    await hosted()
    await open()

    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'crucible#133' }))
    })

    expect(within(pane()).getByText('No description.')).toBeInTheDocument()
  })
})

describe('starting work on an issue', () => {
  // The buttons carry their key beside the word, so the name is matched from
  // its start rather than whole.
  async function align(kind: RegExp = /^Align/): Promise<Shelf> {
    const shelf = await hosted()
    await open()
    await click(kind)
    return shelf
  }

  it('makes a session that remembers the issue it was started on', async () => {
    const { port } = await align()

    expect(port.calls).toContainEqual({
      op: 'createSession',
      args: ['w1', { issue: 'crucible#128' }]
    })
  })

  it('always makes a worktree for it, never the workspace checkout', async () => {
    const { workspace } = await align()

    expect(workspace.calls).toContainEqual({ op: 'createWorktree', args: ['/repos/crucible'] })
  })

  it('sends the interview with the reference, the title and the URL', async () => {
    const { port, workspace } = await align()
    await act(async () => {
      workspace.settleWorktree({
        ok: true,
        path: '/repos/crucible/.crucible/worktrees/9f3a2c',
        branch: 'crucible/9f3a2c'
      })
    })
    await settled()

    const prompt = port.calls.find((call) => call.op === 'prompt')
    expect(prompt?.args[0]).toBe('s-1')
    // The command expanded before it crossed the port: what arrives is text.
    expect(String(prompt?.args[1])).toContain('crucible#128')
    expect(String(prompt?.args[1])).toContain(
      'Quota strip misaligns under the Add workspace button'
    )
    expect(String(prompt?.args[1])).toContain(
      'https://github.com/secondcircle/crucible/issues/128'
    )
  })

  it('quick-aligns from the second button, on the same terms', async () => {
    const { port, workspace } = await align(/^Quick align/)
    await act(async () => {
      workspace.settleWorktree({ ok: true, path: '/w', branch: 'b' })
    })
    await settled()

    const asked = port.calls.find((call) => call.op === 'prompt')
    expect(String(asked?.args[1])).toContain('crucible#128')
  })

  it('closes the board, because the work is now in the session', async () => {
    await align()

    expect(board()).toBeNull()
  })

  it('aligns on ⏎ and quick-aligns on ⇧⏎', async () => {
    const { port } = await hosted()
    await open()

    await press('Enter', { shiftKey: true })

    expect(port.calls).toContainEqual({
      op: 'createSession',
      args: ['w1', { issue: 'crucible#128' }]
    })
  })

  it('holds the command when the worktree script fails, and shows its output', async () => {
    const { port, workspace } = await align()
    await act(async () => {
      workspace.settleWorktree({
        ok: false,
        output: 'The worktree script failed.\nfatal: invalid reference: main'
      })
    })
    await settled()

    // No fall back to the checkout, and nothing sent into a session that has
    // nowhere of its own to work.
    expect(port.calls.some((call) => call.op === 'setWorktree')).toBe(false)
    expect(port.calls.some((call) => call.op === 'prompt')).toBe(false)
    expect(screen.getByText(/fatal: invalid reference: main/)).toBeInTheDocument()
  })
})

describe('an issue a session here already started on', () => {
  const STARTED = {
    ...oneSession(),
    sessions: [
      {
        id: 's1',
        workspaceId: 'w1',
        createdAt: '2026-08-19T14:14:00.000Z',
        title: 'quota strip alignment',
        issue: 'crucible#128',
        working: false,
        fresh: false
      }
    ]
  }

  it('is grouped as picked up rather than hidden', async () => {
    await hosted(STARTED)
    await open()

    const taken = screen.getByRole('option', { name: 'crucible#128' })
    expect(taken).toHaveTextContent('session')
    expect(headings()).toContain('Already picked up')
  })

  it('offers the session it is in, and an align again beside it', async () => {
    const { port } = await hosted(STARTED)
    await open()

    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'crucible#128' }))
    })
    expect(within(pane()).getByText("quota strip alignment")).toBeInTheDocument()

    await click('Open session')

    expect(port.calls).toContainEqual({ op: 'activateSession', args: ['s1'] })
    expect(board()).toBeNull()
  })

  it('stops counting towards the chip: it is no longer waiting to be picked up', async () => {
    await hosted(STARTED)

    expect(chip()).toHaveTextContent('6 issues · 1 yours')
  })
})

describe('what the board never does', () => {
  it('opens the issue in the browser on ⌘⏎ and touches nothing else', async () => {
    const { workspace } = await hosted()
    await open()

    await press('Enter', { metaKey: true })

    expect(workspace.openedUrls).toEqual([
      'https://github.com/secondcircle/crucible/issues/128'
    ])
  })

  it('offers no control that could close, assign, label or comment an issue', async () => {
    await hosted()
    await open()

    const labels = screen
      .getAllByRole('button')
      .map((control) => control.textContent?.toLowerCase() ?? '')
    for (const label of labels) {
      expect(label).not.toMatch(/close issue|assign|label|comment on/)
    }
  })

  it('says so in the footer, where the board answers for itself', async () => {
    await hosted()
    await open()

    expect(
      screen.getByText(/nothing here is closed, assigned or commented for you/)
    ).toBeInTheDocument()
  })
})

describe('the filter', () => {
  async function type(text: string): Promise<void> {
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Filter issues'), { target: { value: text } })
    })
  }

  it('narrows the list to what a person typed, by number, title or label', async () => {
    await hosted()
    await open()

    await type('quota')
    expect(rows()).toEqual(['crucible#128'])

    await type('#124')
    expect(rows()).toEqual(['crucible#124'])

    await type('feature')
    expect(rows()).toEqual(['crucible#133'])
  })

  it('moves the read with it, so the pane is never on a hidden row', async () => {
    await hosted()
    await open()

    await type('worktree')

    expect(within(pane()).getByRole('heading', { level: 3 })).toHaveTextContent(
      'Worktree script failures should print the whole output'
    )
  })

  it('says what it found nothing for, rather than looking empty', async () => {
    await hosted()
    await open()

    await type('nothing like this exists')

    expect(screen.getByText(/Nothing here matches/)).toHaveTextContent(
      'nothing like this exists'
    )
  })

  it('asks the host nothing: it narrows what is already on screen', async () => {
    const { workspace } = await hosted()
    await open()
    const asked = workspace.calls.filter((call) => call.op === 'issueBoard').length

    await type('quota')

    expect(workspace.calls.filter((call) => call.op === 'issueBoard')).toHaveLength(asked)
  })
})

describe('typing in the filter', () => {
  it('keeps the caret keys and the copy, and still aligns on Enter', async () => {
    const { port } = await hosted()
    await open()
    const input = screen.getByLabelText('Filter issues')

    // Arrows belong to whoever is typing: the read does not move under them.
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' })
    })
    expect(within(pane()).getByRole('heading', { level: 3 })).toHaveTextContent(
      'Quota strip misaligns under the Add workspace button'
    )

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(port.calls).toContainEqual({
      op: 'createSession',
      args: ['w1', { issue: 'crucible#128' }]
    })
  })
})

describe('a board whose host is Jira', () => {
  /** The same workspace, answering with a Jira project instead. */
  async function jira(snapshot: Partial<ShellSnapshot> = oneSession()): Promise<Shelf> {
    return shell((workspace) => {
      workspace.issues.set('/repos/crucible', { kind: 'board', board: jiraIssues() })
    }, snapshot)
  }

  it('names the project and the host over the same board', async () => {
    await jira()
    await open()

    expect(document.querySelector('.issues .repo')).toHaveTextContent('EK · Jira')
  })

  it('names each issue by its key, in the rows and in the pane', async () => {
    await jira()
    await open()

    expect(rows()).toEqual(['EK-341', 'EK-352'])
    expect(screen.getByRole('option', { name: 'EK-341' })).toHaveTextContent('EK-341')
    expect(pane()).toHaveTextContent('EK-341')
    // Never the bare GitHub form.
    expect(pane()).not.toHaveTextContent('#341')
  })

  it('offers the browse button and the key in Jira’s words', async () => {
    await jira()
    await open()

    expect(screen.getByRole('button', { name: /^Open in Jira/ })).toBeInTheDocument()
    expect(document.querySelector('.issues .bfoot')).toHaveTextContent('open in Jira')
  })

  it('restates the read-only guarantee in Jira’s verbs', async () => {
    await jira()
    await open()

    expect(document.querySelector('.issues .bfoot .sp')).toHaveTextContent(
      'Jira, read-only · nothing here is transitioned, assigned or commented for you'
    )
  })

  it("keeps a teammate's ticket one click away, never hidden", async () => {
    await jira()
    await open()

    expect(rows()).not.toContain('EK-349')

    await click("show everyone's")

    expect(headings()).toContain('Assigned to others')
    expect(rows()).toContain('EK-349')
  })

  it('never shows a mentions group, there being no such question of Jira', async () => {
    await jira()
    await open()
    await click("show everyone's")

    expect(headings()).not.toContain('Mentions you')
  })

  it('folds a ticket a session here started on into picked up', async () => {
    await jira({
      ...oneSession(),
      sessions: [
        {
          id: 's1',
          workspaceId: 'w1',
          createdAt: '2026-08-19T14:14:00.000Z',
          title: 'address line import',
          issue: 'EK-341',
          working: false,
          fresh: false
        }
      ]
    })
    await open()

    expect(screen.getByRole('option', { name: 'EK-341' })).toHaveTextContent('session')
    expect(headings()).toContain('Already picked up')
  })

  it('starts a session on the key, exactly as it does on a GitHub reference', async () => {
    const { port } = await jira()
    await open()
    await click(/^Align/)

    expect(port.calls).toContainEqual({
      op: 'createSession',
      args: ['w1', { issue: 'EK-341' }]
    })
  })

  it('opens the ticket’s browse URL through the same path', async () => {
    const { workspace } = await jira()
    await open()
    await press('Enter', { metaKey: true })

    expect(workspace.openedUrls).toEqual(['https://secondcircle.atlassian.net/browse/EK-341'])
  })
})

describe('a workspace where Jira is the host and not yet configured', () => {
  const MISSING = {
    kind: 'notConfigured' as const,
    missing: [
      {
        name: 'JIRA_API_TOKEN',
        where: 'An Atlassian API token. A KEY=VALUE line in .env.local at the workspace root.'
      },
      {
        name: '.crucible/jira.json',
        where: 'Names the project this repository tracks: {"projectKey": "EK"}.'
      }
    ]
  }

  async function unset(): Promise<Shelf> {
    return shell((workspace) => {
      workspace.issues.set('/repos/crucible', MISSING)
    })
  }

  it('shows no chip, because nothing was counted', async () => {
    await unset()

    expect(chip()).toBeNull()
  })

  it('still opens on ⌘I, and says what is missing and where each piece goes', async () => {
    await unset()

    await press('i', { metaKey: true })

    const said = screen.getByRole('alert')
    expect(said).toHaveTextContent('Jira is not set up in this workspace yet.')
    expect(said).toHaveTextContent('JIRA_API_TOKEN')
    expect(said).toHaveTextContent('A KEY=VALUE line in .env.local at the workspace root.')
    expect(said).toHaveTextContent('.crucible/jira.json')
    expect(said).toHaveTextContent('{"projectKey": "EK"}')
    // And that a session can do it, and that reopening re-checks. The doc's
    // name must survive as its own word: JSX swallows the newline between the
    // sentence and the <code> element, so without an explicit space this
    // renders as "docs, asjira.md".
    expect(said).toHaveTextContent('agent docs, as jira.md')
    expect(said).toHaveTextContent(/Open this board again/)
    expect(rows()).toEqual([])
  })

  it('speaks in Jira\u2019s words, there being no other host with this state', async () => {
    await unset()
    await press('i', { metaKey: true })

    expect(document.querySelector('.issues .bfoot')).toHaveTextContent('open in Jira')
    expect(document.querySelector('.issues .bfoot .sp')).toHaveTextContent('Jira, read-only')
  })

  it('closes on ⌘I again, and re-asks the host when it is opened next', async () => {
    const { workspace } = await unset()
    await press('i', { metaKey: true })
    const asked = workspace.calls.filter((call) => call.op === 'issueBoard').length

    await press('i', { metaKey: true })
    expect(board()).toBeNull()

    await press('i', { metaKey: true })
    expect(board()).not.toBeNull()
    expect(workspace.calls.filter((call) => call.op === 'issueBoard').length).toBeGreaterThan(asked)
  })
})
