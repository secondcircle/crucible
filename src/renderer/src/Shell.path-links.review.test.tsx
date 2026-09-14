// @vitest-environment jsdom
//
// REVIEW REPRODUCTION (review-1). Delete this file once the finding is fixed
// and the case is folded into Shell.path-links.test.tsx.
//
// The intent document rules: "The tool chain header's own click
// (expand/collapse) keeps working; the path inside it is a separate target."
// It is a separate target for the mouse and not for the keyboard: the row
// header is a `div role="button"` with its own `onKeyDown`, and a key press
// that lands on the path button inside it bubbles straight to that handler.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Shell } from './Shell'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { createScriptedCommands } from './testing/scripted-commands'
import { sessionsShown } from './testing/sidebar'
import { settled } from './testing/settled'

async function shell(): Promise<ScriptedPort> {
  const port = createScriptedPort(oneSession())
  const workspace = createScriptedWorkspace(['src/shared/agent/port.ts', 'Makefile', '.gitignore'])
  render(<Shell port={port} workspace={workspace} commands={createScriptedCommands()} />)
  await sessionsShown()
  await settled()
  return port
}

async function said(port: ScriptedPort, markdown: string): Promise<void> {
  await act(async () => {
    await port.prompt('s1', 'where does that live?')
  })
  await act(async () => {
    port.text('s1', markdown)
    port.endTurn('s1')
  })
  await settled()
}

// The intent document: "a path in an agent message, written in a code span or
// as a markdown link, is clickable when the file exists on disk". A file whose
// name carries no extension is never asked about, so it is never clickable.
describe('a file with no extension, named in a code span', () => {
  it('is a link, because the file is there', async () => {
    const port = await shell()

    await said(port, 'The build rules are in `Makefile`, and `.gitignore` hides the rest.')

    expect(screen.getByRole('button', { name: 'Makefile' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '.gitignore' })).toBeInTheDocument()
  })
})

describe('the path a tool chain row header names, from the keyboard', () => {
  it('is a target of its own, and does not expand the row', async () => {
    const port = await shell()

    await act(async () => {
      await port.prompt('s1', 'read it')
    })
    await act(async () => {
      port.toolStarted('s1', 'c1', 'read', 'src/shared/agent/port.ts')
      port.toolEnded('s1', 'c1', true, 'export type WorkspaceId = string\n')
      port.endTurn('s1')
    })
    await settled()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Tool chain/ }))
    })

    const row = screen.getByRole('button', { name: 'read src/shared/agent/port.ts' })
    const path = screen.getByRole('button', { name: 'src/shared/agent/port.ts' })
    expect(row).toHaveAttribute('aria-expanded', 'false')

    // Enter on the focused path link. A real browser would also fire the
    // button's own click here; the row's keydown handler cancels that (it
    // calls preventDefault) and toggles the row instead.
    await act(async () => {
      fireEvent.keyDown(path, { key: 'Enter' })
    })

    expect(row).toHaveAttribute('aria-expanded', 'false')
  })
})
