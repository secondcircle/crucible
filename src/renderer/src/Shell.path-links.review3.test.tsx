// @vitest-environment jsdom
//
// Review 3's reproduction. Fold the two failing cases into
// `Shell.path-links.test.tsx` and delete this file.
//
// The disk's answers are retired by a stamp of `directory` and the watcher's
// change count. That pair returns to a value it already had: the watch follows
// the shown session, so a change under session A's directory while session B
// is shown increments nothing, and coming back to A remakes the stamp A's
// answers were taken under. Every answer cached before the switch is reused,
// however far the disk has moved in between.
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Shell } from './Shell'
import { createScriptedPort, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace, type ScriptedWorkspace } from './testing/scripted-workspace'
import { createScriptedCommands } from './testing/scripted-commands'
import { sessionsShown } from './testing/sidebar'
import { settled } from './testing/settled'

const FILES: readonly string[] = ['CONTEXT.md', 'package.json']

/** Session one's directory: the checkout itself. */
const WHERE = '/repos/crucible'
/** Session two's: a worktree, so switching sessions moves the watch. */
const OTHER = '/repos/crucible/.crucible/worktrees/run-x'

async function shell(): Promise<{ port: ScriptedPort; workspace: ScriptedWorkspace }> {
  const port = createScriptedPort({
    workspaces: [{ id: 'w1', name: 'crucible', path: WHERE }],
    activeWorkspaceId: 'w1',
    sessions: [
      {
        id: 's1',
        workspaceId: 'w1',
        createdAt: '2026-08-19T15:00:00.000Z',
        title: 'one',
        working: false,
        fresh: false
      },
      {
        id: 's2',
        workspaceId: 'w1',
        createdAt: '2026-08-19T15:20:00.000Z',
        title: 'two',
        working: false,
        fresh: false,
        worktree: { path: OTHER }
      }
    ],
    activeSessionId: 's1'
  })
  const workspace = createScriptedWorkspace(FILES)
  render(<Shell port={port} workspace={workspace} commands={createScriptedCommands()} />)
  await sessionsShown()
  await settled()
  return { port, workspace }
}

async function said(port: ScriptedPort, sessionId: string, markdown: string): Promise<void> {
  await act(async () => {
    await port.prompt(sessionId, 'go')
  })
  await act(async () => {
    port.text(sessionId, markdown)
    port.endTurn(sessionId)
  })
  await settled()
}

async function shown(port: ScriptedPort, sessionId: string): Promise<void> {
  await act(async () => {
    await port.activateSession(sessionId)
  })
  await settled()
}

/** A change under a directory, exactly as main's watcher announces one. */
async function changed(workspace: ScriptedWorkspace, files: readonly string[]): Promise<void> {
  workspace.files = files
  await act(async () => {
    workspace.filesChanged(WHERE)
  })
  await settled()
}

describe('a path answered for before the shown session changed', () => {
  // The everyday order, with the user reading the other session while the
  // first one works: say it, write it, say it was written.
  it('becomes a link once the file is there', async () => {
    const { port, workspace } = await shell()

    await said(port, 's1', 'I will put the plan in `notes/plan.md`.')
    expect(screen.getByText('notes/plan.md').tagName).toBe('CODE')

    await shown(port, 's2')
    expect(workspace.watching.at(-1)).toBe(OTHER)

    // s1's turn runs on while s1 is not the session being shown.
    await changed(workspace, [...FILES, 'notes/plan.md'])

    await shown(port, 's1')
    await said(port, 's1', 'Written: `notes/plan.md`.')

    expect(screen.getAllByText('notes/plan.md').map((node) => node.tagName)).toEqual([
      'BUTTON',
      'BUTTON'
    ])
  })

  // The direction the brief rejected by name: "linking paths that do not exist
  // (a click that fails)". A click on this chip reaches `opened()` in
  // `src/main/panel/model.ts`, which throws `File not found` into a toast.
  it('stops being one once the file is gone', async () => {
    const { port, workspace } = await shell()

    await said(port, 's1', 'The glossary is `CONTEXT.md`.')
    expect(screen.getByText('CONTEXT.md').tagName).toBe('BUTTON')

    await shown(port, 's2')
    await changed(
      workspace,
      FILES.filter((path) => path !== 'CONTEXT.md')
    )
    await shown(port, 's1')

    expect(screen.getByText('CONTEXT.md').tagName).toBe('CODE')
  })

  // The control, so the cache is what the two above measure rather than the
  // session switch breaking the mechanism outright. This one passes.
  it('control: a path first named after the return does link', async () => {
    const { port, workspace } = await shell()

    await shown(port, 's2')
    await changed(workspace, [...FILES, 'notes/plan.md'])
    await shown(port, 's1')
    await said(port, 's1', 'Written: `notes/plan.md`.')

    expect(screen.getByText('notes/plan.md').tagName).toBe('BUTTON')
  })
})
