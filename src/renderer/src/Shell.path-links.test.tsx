// @vitest-environment jsdom
//
// A path an agent names is a way into the file, not a decoration: the disk
// decides which ones are clickable, and a click lands in the session's context
// panel exactly as a click in the file tree does.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import { Shell } from './Shell'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace, type ScriptedWorkspace } from './testing/scripted-workspace'
import { createScriptedCommands } from './testing/scripted-commands'
import { sessionsShown } from './testing/sidebar'
import { settled } from './testing/settled'

const FILES: readonly string[] = [
  '.gitignore',
  'AGENTS.md',
  'CONTEXT.md',
  'Makefile',
  'docs/design/mock-a-ember.html',
  'package.json',
  'src/shared/agent/port.ts'
]

/** Outside the working directory, which an agent names as often as a file in it. */
const INSTALLED = '/Applications/Crucible.app/Contents/Resources/docs/index.md'

async function shell(
  snapshot: Partial<ShellSnapshot> = oneSession()
): Promise<{ port: ScriptedPort; workspace: ScriptedWorkspace }> {
  const port = createScriptedPort(snapshot)
  const workspace = createScriptedWorkspace(FILES)
  workspace.elsewhere = [INSTALLED]
  render(<Shell port={port} workspace={workspace} commands={createScriptedCommands()} />)
  await sessionsShown()
  await settled()
  return { port, workspace }
}

/** One agent message, settled, with the disk's answers about it in hand. */
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

const tabs = (): string[] =>
  screen.queryAllByRole('tab').map((tab) => tab.querySelector('.ttitle')?.textContent ?? '')

const previewTabs = (): string[] =>
  screen
    .queryAllByRole('tab')
    .filter((tab) => tab.classList.contains('preview'))
    .map((tab) => tab.getAttribute('aria-label') ?? '')

const link = (name: string): HTMLElement => screen.getByRole('button', { name })

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element)
  })
}

/** A double-click as a browser delivers one: the clicks first, then the pair. */
async function doubleClick(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element)
    fireEvent.click(element)
    fireEvent.doubleClick(element)
  })
}

const opens = (port: ScriptedPort): readonly unknown[][] =>
  port.calls.filter((call) => call.op === 'openFile').map((call) => [...call.args])

describe('a path in an agent’s message', () => {
  it('is a link when the file is there, and plain code when it is not', async () => {
    const { port } = await shell()

    await said(port, 'The glossary is `CONTEXT.md`; `notes/nothing.md` never landed.')

    expect(link('CONTEXT.md').tagName).toBe('BUTTON')
    expect(screen.getByText('notes/nothing.md').tagName).toBe('CODE')
  })

  it('is not a link where it was written as prose', async () => {
    const { port } = await shell()

    // The same file, named without backticks: too many sentences mention a
    // name that happens to be a file for prose to be worth linking.
    await said(port, 'The glossary is CONTEXT.md, two entries longer than it was.')

    expect(screen.queryByRole('button', { name: /CONTEXT\.md/ })).toBeNull()
  })

  it('stays a code span when the disk has no such file', async () => {
    const { port } = await shell()

    await said(port, 'That was `8dd033a`, switched with `CRUCIBLE_AGENT=sdk`.')

    expect(screen.getByText('8dd033a').tagName).toBe('CODE')
    expect(screen.queryByRole('button', { name: '8dd033a' })).toBeNull()
    expect(screen.getByText('CRUCIBLE_AGENT=sdk').tagName).toBe('CODE')
  })

  it('never asks the disk about a code span that could not be a path at all', async () => {
    const { port, workspace } = await shell()

    await said(port, 'Run `npm run dev`, never `https://example.test/`, and not `docs/adr/`.')

    const asked = workspace.calls
      .filter((call) => call.op === 'existingFiles')
      .flatMap((call) => call.args[1] as readonly string[])
    expect(asked).toEqual([])
  })

  // Nothing in the shape of `Makefile` tells it from `panel_show`, so the disk
  // is asked about both, and every extension-less file a repository has —
  // `Makefile`, `.gitignore`, `LICENSE` — opens like any other.
  it('is a link when the file carries no extension', async () => {
    const { port } = await shell()

    await said(port, 'The build rules are in `Makefile`, and `.gitignore` hides the rest.')

    expect(link('Makefile').tagName).toBe('BUTTON')
    await click(link('.gitignore'))

    expect(opens(port)).toEqual([['s1', '.gitignore', { keep: false, view: { kind: 'rendered' } }]])
  })

  it('opens the file as the session’s preview tab, and keeps it on a double-click', async () => {
    const { port } = await shell()
    await said(port, 'See `CONTEXT.md` and `package.json`.')

    await click(link('CONTEXT.md'))

    expect(opens(port)).toEqual([['s1', 'CONTEXT.md', { keep: false, view: { kind: 'rendered' } }]])
    expect(tabs()).toEqual(['CONTEXT.md'])
    expect(previewTabs()).toEqual(['CONTEXT.md (preview)'])

    // The next single click replaces the previewed file, exactly as in the tree.
    await click(link('package.json'))
    expect(tabs()).toEqual(['package.json'])

    await doubleClick(link('CONTEXT.md'))
    expect(previewTabs()).toEqual([])
    expect(port.calls.filter((call) => call.op === 'keepTab')).toHaveLength(1)
  })

  it('opens markdown rendered and everything else as source', async () => {
    const { port } = await shell()
    await said(port, 'Both `CONTEXT.md` and `src/shared/agent/port.ts`.')

    await click(link('CONTEXT.md'))
    expect(screen.getByRole('tab', { name: 'CONTEXT.md (preview)' })).toHaveTextContent('md')

    await click(link('src/shared/agent/port.ts'))
    expect(opens(port).at(-1)).toEqual([
      's1',
      'src/shared/agent/port.ts',
      { keep: false, view: { kind: 'rendered' } }
    ])
    // Source is what a file with no rendered view of its own opens as.
    expect(screen.getByRole('tab', { name: 'port.ts (preview)' })).toHaveTextContent('ts')
  })

  it('opens a path:line on that line, highlighted', async () => {
    const { port } = await shell()
    port.exhibits.set('port', 'one\ntwo\nthree\nfour\n')

    await said(port, 'It is declared at `src/shared/agent/port.ts:3`.')
    await click(link('src/shared/agent/port.ts:3'))

    expect(opens(port)).toEqual([
      ['s1', 'src/shared/agent/port.ts', { keep: false, view: { kind: 'source', line: 3 } }]
    ])
    const marked = document.querySelectorAll('.src .ln.hl')
    expect(marked).toHaveLength(1)
    expect(marked[0].textContent).toBe('3three')
  })

  it('opens an absolute path from anywhere on disk', async () => {
    const { port } = await shell()

    await said(port, `The installed docs are at \`${INSTALLED}\`.`)
    await click(link(INSTALLED))

    expect(tabs()).toEqual(['index.md'])
  })

  it('lands on the tab a file already has rather than opening a second', async () => {
    const { port } = await shell()
    await said(port, 'See `CONTEXT.md`, twice: `CONTEXT.md`.')

    const [first, second] = screen.getAllByRole('button', { name: 'CONTEXT.md' })
    await doubleClick(first)
    await click(second)

    expect(tabs()).toEqual(['CONTEXT.md'])
  })

  it('resolves a relative path against the session’s worktree', async () => {
    const { port, workspace } = await shell(
      oneSession({ worktree: { path: '/repos/crucible/.crucible/worktrees/run-f5d2' } })
    )

    await said(port, 'Look at `CONTEXT.md`.')
    await click(link('CONTEXT.md'))

    expect(workspace.calls).toContainEqual({
      op: 'existingFiles',
      args: ['/repos/crucible/.crucible/worktrees/run-f5d2', ['CONTEXT.md']]
    })
    const tab = port.panelOf('s1')?.tabs[0]
    expect(tab?.kind !== 'url' && tab?.path).toBe(
      '/repos/crucible/.crucible/worktrees/run-f5d2/CONTEXT.md'
    )
  })
})

describe('a markdown link in an agent’s message', () => {
  it('opens a file it points at in the panel', async () => {
    const { port } = await shell()

    await said(port, 'Read [the glossary](CONTEXT.md) first.')
    await click(link('the glossary'))

    expect(opens(port)).toEqual([['s1', 'CONTEXT.md', { keep: false, view: { kind: 'rendered' } }]])
  })

  it('stays the text it was written as when the file is not there', async () => {
    const { port } = await shell()

    await said(port, 'Read [the plan](notes/plan.md) first.')

    expect(screen.queryByRole('button', { name: 'the plan' })).toBeNull()
    expect(screen.getByText(/\[the plan\]\(notes\/plan\.md\)/)).toBeInTheDocument()
  })

  it('opens a localhost address as a web tab, and hands every other address to the browser', async () => {
    const { port } = await shell()

    await said(port, 'Try [the dev server](http://localhost:5173/) or [the site](https://example.test/).')

    await click(link('the dev server'))
    expect(port.calls).toContainEqual({
      op: 'openAddress',
      args: ['s1', 'http://localhost:5173/', { keep: false }]
    })
    expect(tabs()).toEqual(['localhost'])

    const outside = screen.getByRole('link', { name: 'the site' })
    expect(outside).toHaveAttribute('href', 'https://example.test/')
    expect(outside).toHaveAttribute('target', '_blank')
  })
})

describe('where a path is not a link', () => {
  it('is not one in the user’s own message', async () => {
    await shell()

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Message'), {
        target: { value: 'open CONTEXT.md and `package.json`' }
      })
    })
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' })
    })
    await settled()

    // A person's own message is plain text, backticks and all.
    expect(screen.queryByRole('button', { name: 'package.json' })).toBeNull()
    expect(screen.getByText('open CONTEXT.md and `package.json`')).toBeInTheDocument()
  })

  it('is not one in a tool’s output', async () => {
    const { port } = await shell()

    await act(async () => {
      await port.prompt('s1', 'list them')
    })
    await act(async () => {
      port.toolStarted('s1', 'c1', 'bash', 'ls')
      port.toolEnded('s1', 'c1', true, 'CONTEXT.md\npackage.json\n')
      port.endTurn('s1')
    })
    await settled()

    await click(screen.getByRole('button', { name: /^Tool chain/ }))
    expect(screen.queryByRole('button', { name: 'package.json' })).toBeNull()
  })
})

describe('the path a tool chain row header names', () => {
  /** One settled `read`, with its chain open so the call's own row shows. */
  async function readRow(port: ScriptedPort, summary: string): Promise<void> {
    await act(async () => {
      await port.prompt('s1', 'read it')
    })
    await act(async () => {
      port.toolStarted('s1', 'c1', 'read', summary)
      port.toolEnded('s1', 'c1', true, 'export type WorkspaceId = string\n')
      port.endTurn('s1')
    })
    await settled()
    await click(screen.getByRole('button', { name: /^Tool chain/ }))
  }

  it('opens the file, and does not expand the row', async () => {
    const { port } = await shell()
    await readRow(port, 'src/shared/agent/port.ts')

    const row = screen.getByRole('button', { name: 'read src/shared/agent/port.ts' })
    await click(link('src/shared/agent/port.ts'))

    expect(opens(port)).toEqual([
      ['s1', 'src/shared/agent/port.ts', { keep: false, view: { kind: 'rendered' } }]
    ])
    // The row's own click is untouched: it is still collapsed, and still opens.
    expect(row).toHaveAttribute('aria-expanded', 'false')
    await click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')
  })

  // The two targets are two controls side by side, not one inside the other.
  // Nested, every key that reached the path reached the row as well: Enter on
  // the path expanded the row, and the row's `preventDefault` cancelled the
  // button's own activation on the way. jsdom fires no native activation, so
  // what is asserted here is the shape that decides it — the row is not an
  // ancestor of the path — and the row staying shut under the key press.
  it('is a target of its own from the keyboard, and never the row', async () => {
    const { port } = await shell()
    await readRow(port, 'src/shared/agent/port.ts')

    const row = screen.getByRole('button', { name: 'read src/shared/agent/port.ts' })
    const path = link('src/shared/agent/port.ts')
    expect(row.contains(path)).toBe(false)

    await act(async () => {
      fireEvent.keyDown(path, { key: 'Enter' })
      fireEvent.keyDown(path, { key: ' ' })
    })

    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(opens(port)).toEqual([])
  })

  // What a `read` names is the whole summary, so a file with no extension is
  // as clickable here as in a message.
  it('links a file with no extension', async () => {
    const { port } = await shell()
    await readRow(port, 'Makefile')

    const row = screen.getByRole('button', { name: 'read Makefile' })
    await click(within(row.parentElement as HTMLElement).getByRole('button', { name: 'Makefile' }))

    expect(opens(port)).toEqual([['s1', 'Makefile', { keep: false, view: { kind: 'rendered' } }]])
    expect(row).toHaveAttribute('aria-expanded', 'false')
  })
})
