// @vitest-environment jsdom
//
// `@` searches the workspace and inserts a path as plain text. Nothing is
// attached, nothing is read, and nothing crosses the agent port (Q9/Q20).
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Shell } from './Shell'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace, type ScriptedWorkspace } from './testing/scripted-workspace'
import { settled } from './testing/settled'

const FILES: readonly string[] = [
  'src/renderer/src/components/Composer.tsx',
  'src/renderer/src/components/composer.css',
  'src/renderer/src/components/Transcript.tsx',
  'src/shared/agent/port.ts',
  'package.json'
]

async function shell(): Promise<{ port: ScriptedPort; workspace: ScriptedWorkspace }> {
  const port = createScriptedPort(oneSession())
  port.models = [{ id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off'] }]
  const workspace = createScriptedWorkspace(FILES)
  render(<Shell port={port} workspace={workspace} />)
  await screen.findAllByRole('button', { name: /^Session · / })
  await settled()
  return { port, workspace }
}

const box = (): HTMLTextAreaElement => screen.getByLabelText('Message') as HTMLTextAreaElement

/** Typed the way a person types it: the caret ends up after the text. */
async function type(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(box(), { target: { value: text, selectionStart: text.length } })
  })
}

const popover = (): HTMLElement | null =>
  screen.queryByRole('listbox', { name: 'Files in this workspace' })

const rows = (): string[] =>
  Array.from(document.querySelectorAll('.popitem')).map((row) => row.textContent ?? '')

describe('the @ popover', () => {
  it('opens on the token and asks the workspace service, never the port', async () => {
    const { port, workspace } = await shell()

    await type('look at @')

    expect(popover()).not.toBeNull()
    expect(workspace.calls).toContainEqual({
      op: 'searchFiles',
      args: ['/repos/crucible', '']
    })
    expect(port.calls.map((call) => call.op)).not.toContain('searchHistory')
  })

  it('refilters on every keystroke', async () => {
    const { workspace } = await shell()

    await type('look at @comp')

    expect(workspace.calls.at(-1)).toEqual({
      op: 'searchFiles',
      args: ['/repos/crucible', 'comp']
    })
    // Filename matches first, then a match anywhere in the path, each group
    // alphabetically: the same order every time.
    expect(rows()).toEqual([
      'composer.csssrc/renderer/src/components',
      'Composer.tsxsrc/renderer/src/components',
      'Transcript.tsxsrc/renderer/src/components'
    ])
  })

  it('says so when nothing matches', async () => {
    await shell()

    await type('@zzzz')

    expect(screen.getByText('No files match')).toBeInTheDocument()
    expect(rows()).toEqual([])
  })

  it('never sends on Enter while the popover is open, even with no match', async () => {
    const { port } = await shell()
    await type('@zzzz')
    expect(screen.getByText('No files match')).toBeInTheDocument()

    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter' })
    })

    // Spec §25: while the popover is open, Enter never sends the message. The
    // empty state is still the popover, open.
    expect(port.calls.map((call) => call.op)).not.toContain('prompt')
  })

  it('inserts the workspace-relative path as plain text on Enter', async () => {
    const { port } = await shell()
    await type('look at @comp')

    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter' })
    })

    expect(box()).toHaveValue('look at @src/renderer/src/components/composer.css ')
    expect(popover()).toBeNull()
    // Enter never sent the message while the popover was open.
    expect(port.calls.map((call) => call.op)).not.toContain('prompt')
  })

  it('inserts on Tab as well, from the row the arrows chose', async () => {
    await shell()
    await type('@comp')

    await act(async () => {
      fireEvent.keyDown(box(), { key: 'ArrowDown' })
    })
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Tab' })
    })

    expect(box()).toHaveValue('@src/renderer/src/components/Composer.tsx ')
  })

  it('inserts on a click', async () => {
    await shell()
    await type('@port')

    await act(async () => {
      fireEvent.click(screen.getByText('port.ts'))
    })

    expect(box()).toHaveValue('@src/shared/agent/port.ts ')
  })

  it('closes on Escape without sending anything', async () => {
    const { port } = await shell()
    await type('@comp')

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })

    expect(popover()).toBeNull()
    expect(box()).toHaveValue('@comp')
    expect(port.calls.map((call) => call.op)).not.toContain('prompt')
  })

  it('opens from the composer chip, which is the mouse path to it', async () => {
    const { workspace } = await shell()

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Mention a file'))
    })

    expect(box()).toHaveValue('@')
    expect(popover()).not.toBeNull()
    expect(workspace.calls).toHaveLength(1)
  })

  it('stays shut in bash mode, where `@` means nothing', async () => {
    await shell()

    await type('!grep @comp')

    expect(popover()).toBeNull()
  })
})
