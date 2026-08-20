// @vitest-environment jsdom
//
// The composer chip is the whole control: one element, six states, and the
// only place a branch name is shown. Creation is the workspace service's; what
// the session then holds crosses the agent port.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import { Shell } from './Shell'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace, type ScriptedWorkspace } from './testing/scripted-workspace'
import { createScriptedCommands } from './testing/scripted-commands'
import { settled } from './testing/settled'

const WORKTREE = '/repos/crucible/.crucible/worktrees/9f3a2c'

const MADE = { ok: true as const, path: WORKTREE, branch: 'crucible/9f3a2c' }

const TWO_FRESH: ShellSnapshot = {
  workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
  activeWorkspaceId: 'w1',
  sessions: [
    { id: 's1', workspaceId: 'w1', createdAt: '2026-08-19T14:14:00.000Z', working: false, fresh: true },
    { id: 's2', workspaceId: 'w1', createdAt: '2026-08-19T15:20:00.000Z', working: false, fresh: true }
  ],
  activeSessionId: 's1'
}

async function shell(
  snapshot: Partial<ShellSnapshot> = oneSession({ fresh: true }),
  { git = true }: { git?: boolean } = {}
): Promise<{ port: ScriptedPort; workspace: ScriptedWorkspace }> {
  const port = createScriptedPort(snapshot)
  port.models = [{ id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off', 'low'] }]
  const workspace = createScriptedWorkspace(['src/shared/agent/port.ts'])
  workspace.git = git
  render(<Shell port={port} workspace={workspace} commands={createScriptedCommands()} />)
  await screen.findAllByRole('button', { name: /^Session · / })
  await settled()
  return { port, workspace }
}

const chip = (): HTMLButtonElement | null =>
  document.querySelector('.chip.wt') as HTMLButtonElement | null

/** The chip, or a failure that says the state under test never rendered. */
function theChip(): HTMLButtonElement {
  const found = chip()
  if (found === null) throw new Error('no worktree chip is rendered')
  return found
}

const output = (): string | undefined =>
  document.querySelector('.wtout')?.textContent ?? undefined

const box = (): HTMLTextAreaElement => screen.getByLabelText('Message') as HTMLTextAreaElement

const send = (): HTMLButtonElement =>
  screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement

async function type(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(box(), { target: { value: text, selectionStart: text.length } })
  })
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element)
  })
}

/** A click and nothing after it, which is where "same frame" is looked at. */
function clickNow(element: HTMLElement): void {
  act(() => {
    fireEvent.click(element)
  })
}

async function flipAndSettle(
  workspace: ScriptedWorkspace,
  created = MADE as Parameters<ScriptedWorkspace['settleWorktree']>[0]
): Promise<void> {
  await click(theChip())
  await act(async () => {
    workspace.settleWorktree(created)
    await settled()
  })
}

describe('a fresh session on the checkout', () => {
  it('shows the chip beside model and thinking, saying where it works', async () => {
    await shell()

    expect(theChip()).toHaveTextContent('checkout')
    expect(theChip()).toBeEnabled()
    expect(theChip()).toHaveAccessibleName('This session works in the checkout')
    // Beside the other two chips, in the composer's own row.
    expect(theChip().closest('.crow')).not.toBeNull()
  })

  it('is not there at all in a workspace that is not a git working tree', async () => {
    const { workspace } = await shell(oneSession({ fresh: true }), { git: false })

    expect(chip()).toBeNull()
    expect(workspace.calls).toContainEqual({
      op: 'isGitWorkspace',
      args: ['/repos/crucible']
    })
  })
})

describe('flipping to a worktree', () => {
  it('starts the creation and looks busy in the same frame as the click', async () => {
    const { workspace } = await shell()

    clickNow(theChip())

    expect(theChip()).toHaveTextContent('creating worktree…')
    expect(theChip()).toBeDisabled()
    expect(theChip().className).toContain('busy')
    expect(workspace.calls).toContainEqual({
      op: 'createWorktree',
      args: ['/repos/crucible']
    })
  })

  it('blocks sending while the directory of the message is unsettled', async () => {
    const { port } = await shell()
    await type('read the store')

    clickNow(theChip())

    expect(send()).toBeDisabled()
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter' })
    })
    expect(port.calls.map((call) => call.op)).not.toContain('prompt')
    // The draft is untouched: it is waiting, not lost.
    expect(box()).toHaveValue('read the store')
  })

  it('shows the branch as the chip’s label once the worktree is ready', async () => {
    const { port, workspace } = await shell()
    await type('read the store')

    await flipAndSettle(workspace)

    expect(theChip()).toHaveTextContent('crucible/9f3a2c')
    expect(theChip()).toBeEnabled()
    expect(theChip().className).toContain('on')
    expect(port.calls).toContainEqual({
      op: 'setWorktree',
      args: ['s1', { path: WORKTREE, branch: 'crucible/9f3a2c' }]
    })
    expect(send()).toBeEnabled()
  })

  it('falls back to the directory’s own name when the branch is unknown', async () => {
    const { workspace } = await shell()

    await flipAndSettle(workspace, { ok: true, path: '/elsewhere/detached-tree' })

    expect(theChip()).toHaveTextContent('detached-tree')
  })

  it('goes back to the checkout on a second flip, deleting nothing', async () => {
    const { port, workspace } = await shell()
    await flipAndSettle(workspace)

    port.holdWorktree = true
    clickNow(theChip())
    // Still in the worktree until the rebind lands, and saying so: the chip
    // shows the working treatment without claiming it has moved.
    expect(theChip()).toHaveTextContent('crucible/9f3a2c')
    expect(theChip()).toBeDisabled()
    expect(theChip().className).toContain('busy')
    expect(theChip()).toHaveAttribute('aria-busy', 'true')

    await act(async () => {
      port.settleWorktreeChange()
      await settled()
    })
    await act(async () => {
      await settled()
    })

    expect(theChip()).toHaveTextContent('checkout')
    // Detached, never deleted: nothing was asked of the workspace service.
    expect(port.calls.at(-1)).toEqual({ op: 'setWorktree', args: ['s1'] })
    expect(workspace.calls.filter((call) => call.op === 'createWorktree')).toHaveLength(1)
  })
})

describe('when creation fails', () => {
  const FAILED = {
    ok: false as const,
    output: '.crucible/worktree exited 1\nfatal: invalid reference: HEAD\n'
  }

  it('leaves the session on the checkout and shows what was printed', async () => {
    const { port, workspace } = await shell()

    await flipAndSettle(workspace, FAILED)

    expect(theChip()).toHaveTextContent('checkout')
    expect(theChip()).toBeEnabled()
    expect(output()).toBe(FAILED.output)
    expect(port.calls.map((call) => call.op)).not.toContain('setWorktree')
  })

  it('shows a rebind the port refused the same way', async () => {
    const { workspace, port } = await shell()
    port.worktreeRefusal = 'That conversation could not be opened.'

    await flipAndSettle(workspace)

    expect(theChip()).toHaveTextContent('checkout')
    expect(output()).toBe('That conversation could not be opened.')
  })

  it('clears the output on the next attempt', async () => {
    const { workspace } = await shell()
    await flipAndSettle(workspace, FAILED)

    clickNow(theChip())

    expect(output()).toBeUndefined()
  })

  it('clears the output when the user goes to another session', async () => {
    const { workspace } = await shell(TWO_FRESH)
    await flipAndSettle(workspace, FAILED)

    await click(screen.getAllByRole('button', { name: /^Session · / })[1])

    expect(output()).toBeUndefined()
  })
})

describe('once the session has a conversation', () => {
  it('keeps the chip’s label and stops being a control', async () => {
    const { port, workspace } = await shell()
    await flipAndSettle(workspace)

    await type('read the store')
    await click(send())

    expect(theChip()).toHaveTextContent('crucible/9f3a2c')
    expect(theChip()).toBeDisabled()
    // Nothing over the top: no explanation, no tooltip, no second element.
    expect(theChip().title).toBe('')
    await click(theChip())
    expect(port.calls.filter((call) => call.op === 'setWorktree')).toHaveLength(1)
  })

  it('locks a checkout session’s chip the same way', async () => {
    const { port } = await shell()

    await type('read the store')
    await click(send())

    expect(theChip()).toHaveTextContent('checkout')
    expect(theChip()).toBeDisabled()
    expect(port.calls.map((call) => call.op)).not.toContain('setWorktree')
  })
})

describe('a creation the user walked away from', () => {
  it('belongs to the session it was flipped for, whatever is on screen', async () => {
    const { port, workspace } = await shell(TWO_FRESH)

    clickNow(theChip())
    await click(screen.getAllByRole('button', { name: /^Session · / })[1])
    // The second session is on the checkout and unbothered by the first's
    // creation.
    expect(theChip()).toHaveTextContent('checkout')

    await act(async () => {
      workspace.settleWorktree(MADE)
      await settled()
    })

    expect(port.calls).toContainEqual({
      op: 'setWorktree',
      args: ['s1', { path: WORKTREE, branch: 'crucible/9f3a2c' }]
    })
    expect(theChip()).toHaveTextContent('checkout')
  })

  it('discards the result when that session is gone, and leaves the worktree', async () => {
    const { port, workspace } = await shell(TWO_FRESH)

    clickNow(theChip())
    await click(screen.getAllByRole('button', { name: /^Remove Session · / })[0])
    expect(screen.getAllByRole('button', { name: /^Session · / })).toHaveLength(1)

    await act(async () => {
      workspace.settleWorktree(MADE)
      await settled()
    })

    // The worktree the script made is left exactly where it is: nothing is
    // attached to a session that is no longer there, and nothing is removed.
    expect(port.calls.map((call) => call.op)).not.toContain('setWorktree')
  })

  it('lets two fresh sessions create at once, independently', async () => {
    const { port, workspace } = await shell(TWO_FRESH)

    clickNow(theChip())
    await click(screen.getAllByRole('button', { name: /^Session · / })[1])
    clickNow(theChip())
    expect(workspace.creating()).toBe(2)

    await act(async () => {
      workspace.settleWorktree(MADE)
      workspace.settleWorktree({ ok: true, path: '/repos/crucible/.crucible/worktrees/4b81de', branch: 'crucible/4b81de' })
      await settled()
    })

    expect(port.calls).toContainEqual({
      op: 'setWorktree',
      args: ['s1', { path: WORKTREE, branch: 'crucible/9f3a2c' }]
    })
    expect(port.calls).toContainEqual({
      op: 'setWorktree',
      args: [
        's2',
        { path: '/repos/crucible/.crucible/worktrees/4b81de', branch: 'crucible/4b81de' }
      ]
    })
  })
})

describe('the sidebar', () => {
  it('marks a worktree session with the glyph, and says so in its name', async () => {
    const { workspace } = await shell(TWO_FRESH)

    await flipAndSettle(workspace)

    const rows = screen.getAllByRole('button', { name: /^Session · / })
    expect(rows[0]).toHaveAccessibleName(/\(worktree\)$/)
    expect(rows[0]?.querySelector('.wt')?.textContent).toBe('⑂')
    // Checkout sessions get no glyph at all, and no branch name is shown
    // anywhere in the column.
    expect(rows[1]?.querySelector('.wt')).toBeNull()
    expect(document.querySelector('.side')?.textContent).not.toContain('crucible/9f3a2c')
  })
})

describe('work follows the worktree', () => {
  it('runs a bash command there, and says so on the badge', async () => {
    const { workspace } = await shell()
    await flipAndSettle(workspace)

    await type('!git status')
    expect(screen.getByText(`· ${WORKTREE}`)).toBeInTheDocument()
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter' })
    })

    expect(workspace.calls).toContainEqual({ op: 'startRun', args: [WORKTREE, 'git status'] })
  })

  it('searches files there', async () => {
    const { workspace } = await shell()
    await flipAndSettle(workspace)

    await type('look at @port')

    expect(workspace.calls.at(-1)).toEqual({ op: 'searchFiles', args: [WORKTREE, 'port'] })
  })
})
