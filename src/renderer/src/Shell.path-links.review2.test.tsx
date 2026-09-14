// @vitest-environment jsdom
//
// Review 2's reproduction. Delete this file once the cases are folded into
// `Shell.path-links.test.tsx`.
//
// `usePathLinks` keeps the disk's answer about a path for the life of the
// window, keyed by directory and path, and nothing ever takes one back. The
// disk moves under it in both directions.
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Shell } from './Shell'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace, type ScriptedWorkspace } from './testing/scripted-workspace'
import { createScriptedCommands } from './testing/scripted-commands'
import { sessionsShown } from './testing/sidebar'
import { settled } from './testing/settled'

const FILES: readonly string[] = ['CONTEXT.md', 'src/shared/agent/port.ts']

/** The directory `oneSession()` puts the session in. */
const WHERE = '/repos/crucible'

async function shell(): Promise<{ port: ScriptedPort; workspace: ScriptedWorkspace }> {
  const port = createScriptedPort(oneSession())
  const workspace = createScriptedWorkspace([...FILES])
  render(<Shell port={port} workspace={workspace} commands={createScriptedCommands()} />)
  await sessionsShown()
  await settled()
  return { port, workspace }
}

async function said(port: ScriptedPort, markdown: string): Promise<void> {
  await act(async () => {
    await port.prompt('s1', 'go on')
  })
  await act(async () => {
    port.text('s1', markdown)
    port.endTurn('s1')
  })
  await settled()
}

/** A change on disk, announced exactly as main's watcher announces one. */
async function changed(workspace: ScriptedWorkspace, files: readonly string[]): Promise<void> {
  workspace.files = files
  await act(async () => {
    workspace.filesChanged(WHERE)
  })
  await settled()
}

describe('a path the disk answered for once', () => {
  // The everyday order: the agent says what it is about to write, writes it,
  // then says it wrote it. The first mention is answered "not a file" and that
  // answer is cached, so the second mention — of a file that is now genuinely
  // on disk — is still dead text.
  it('becomes a link once the file is there', async () => {
    const { port, workspace } = await shell()

    await said(port, 'I will put the plan in `notes/plan.md`.')
    expect(screen.getByText('notes/plan.md').tagName).toBe('CODE')

    await changed(workspace, [...FILES, 'notes/plan.md'])
    await said(port, 'Written: `notes/plan.md`.')

    expect(screen.getAllByText('notes/plan.md').at(-1)?.tagName).toBe('BUTTON')
  })

  // The other direction, and the one the brief rejected outright: "linking
  // paths that do not exist (a click that fails)". The answer stays true after
  // the file goes, so the chip stays clickable and main's `opened()` throws
  // `File not found` into a toast.
  it('stops being one once the file is gone', async () => {
    const { port, workspace } = await shell()

    await said(port, 'The glossary is `CONTEXT.md`.')
    expect(screen.getByRole('button', { name: 'CONTEXT.md' })).toBeInTheDocument()

    await changed(workspace, ['src/shared/agent/port.ts'])
    await said(port, 'I removed it: `CONTEXT.md` is gone.')

    // Both mentions are dead text now; the second one certainly is. Instead
    // they stay buttons, and a click on one reaches main's `opened()`, which
    // throws `File not found: …` into a toast.
    expect(screen.getAllByText('CONTEXT.md').at(-1)?.tagName).toBe('CODE')
  })
})
