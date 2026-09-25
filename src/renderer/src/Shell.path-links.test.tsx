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

/** The directory `oneSession()` puts the session in. */
const WHERE = '/repos/crucible'

/** A second session's worktree, so switching sessions moves the watch. */
const OTHER = '/repos/crucible/.crucible/worktrees/run-x'

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

/** The session on screen, as clicking one in the sidebar makes it. */
async function shown(port: ScriptedPort, sessionId: string): Promise<void> {
  await act(async () => {
    await port.activateSession(sessionId)
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

/** A change on disk, announced exactly as main's watcher announces one. */
async function changed(workspace: ScriptedWorkspace, files: readonly string[]): Promise<void> {
  workspace.files = files
  await act(async () => {
    workspace.filesChanged(WHERE)
  })
  await settled()
}

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

// "Clickable when the file exists on disk" is a fact about the disk now, not
// about the first time a path was mentioned. The agent under this transcript
// writes and deletes files as its ordinary work, so an answer that outlives
// the write behind it is wrong within the same turn.
describe('a path the disk has answered for before', () => {
  // The everyday order: the agent says what it is about to write, writes it,
  // and says it wrote it.
  it('becomes a link once the file is there', async () => {
    const { port, workspace } = await shell()

    await said(port, 'I will put the plan in `notes/plan.md`.')
    expect(screen.getByText('notes/plan.md').tagName).toBe('CODE')

    await changed(workspace, [...FILES, 'notes/plan.md'])
    await said(port, 'Written: `notes/plan.md`.')

    // Both mentions, the one made before the file existed included.
    expect(screen.getAllByText('notes/plan.md').map((named) => named.tagName)).toEqual([
      'BUTTON',
      'BUTTON'
    ])
  })

  // The direction the brief rejected by name: "linking paths that do not exist
  // (a click that fails)". A click on a stale chip reaches main's `opened()`,
  // which throws `File not found` into a toast.
  it('stops being one once the file is gone', async () => {
    const { port, workspace } = await shell()

    await said(port, 'The glossary is `CONTEXT.md`.')
    expect(link('CONTEXT.md').tagName).toBe('BUTTON')

    await changed(
      workspace,
      FILES.filter((path) => path !== 'CONTEXT.md')
    )
    await said(port, 'I removed it: `CONTEXT.md` is gone.')

    expect(screen.getAllByText('CONTEXT.md').map((named) => named.tagName)).toEqual([
      'CODE',
      'CODE'
    ])
  })

  // What the two cases above stand on: main only announces a change under a
  // directory something is watching, and chat is read with the file tree shut
  // and no file tab open most of the time this surface is used.
  it('is watched while the session is up, whatever the sidebar is showing', async () => {
    const { workspace } = await shell()

    expect(workspace.watching).toEqual([WHERE])
    expect(document.querySelector('.filetree')).toBeNull()
  })

  // A change under the directory retires the answers; it does not blank the
  // chips while they are taken again, and it costs one round trip however
  // many paths are on screen.
  it('asks again in one round trip, and stays a link while it asks', async () => {
    const { port, workspace } = await shell()

    await said(port, 'See `CONTEXT.md`, `package.json` and `Makefile`.')
    const before = workspace.calls.filter((call) => call.op === 'existingFiles').length

    await act(async () => {
      workspace.filesChanged(WHERE)
    })
    // Before the answers land: the chips are what they were.
    expect(link('CONTEXT.md').tagName).toBe('BUTTON')
    await settled()

    const asked = workspace.calls.filter((call) => call.op === 'existingFiles').slice(before)
    expect(asked).toEqual([
      { op: 'existingFiles', args: [WHERE, ['CONTEXT.md', 'package.json', 'Makefile']] }
    ])
    expect(link('CONTEXT.md').tagName).toBe('BUTTON')
  })
})

// The watch follows the session on screen, and the user reads one session
// while another works: a turn in the session not being shown writes and
// deletes files nothing is counting. So the answers are held against an epoch
// that only ever goes forward — a watch that ends moves it as surely as a
// change does — rather than against a directory and a count that stands still
// while that directory is unwatched and so returns to the value the stale
// answers were taken under.
describe('a path answered for before the session on screen changed', () => {
  /** Two sessions in one workspace: s1 in the checkout, s2 in a worktree. */
  async function two(): Promise<{ port: ScriptedPort; workspace: ScriptedWorkspace }> {
    const one = oneSession()
    return await shell({
      ...one,
      sessions: [
        ...one.sessions,
        {
          id: 's2',
          workspaceId: 'w1',
          createdAt: '2026-08-19T15:20:00.000Z',
          title: 'two',
          working: false,
          fresh: false,
          worktree: { path: OTHER }
        }
      ]
    })
  }

  it('becomes a link once the file is there', async () => {
    const { port, workspace } = await two()

    await said(port, 'I will put the plan in `notes/plan.md`.')
    expect(screen.getByText('notes/plan.md').tagName).toBe('CODE')

    await shown(port, 's2')
    expect(workspace.watching.at(-1)).toBe(OTHER)

    // s1's turn runs on while s1 is not the session being shown, so nothing
    // counts this change.
    await changed(workspace, [...FILES, 'notes/plan.md'])

    await shown(port, 's1')
    await said(port, 'Written: `notes/plan.md`.')

    expect(screen.getAllByText('notes/plan.md').map((named) => named.tagName)).toEqual([
      'BUTTON',
      'BUTTON'
    ])
  })

  it('stops being one once the file is gone', async () => {
    const { port, workspace } = await two()

    await said(port, 'The glossary is `CONTEXT.md`.')
    expect(link('CONTEXT.md').tagName).toBe('BUTTON')

    await shown(port, 's2')
    await changed(
      workspace,
      FILES.filter((path) => path !== 'CONTEXT.md')
    )
    await shown(port, 's1')

    expect(screen.getByText('CONTEXT.md').tagName).toBe('CODE')
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

// A bare address opens where a markdown link to it opens: a page served on
// this machine in the panel, every other page in the browser that holds the
// user's logins.
describe('a bare web address in an agent’s message', () => {
  const address = (name: string): HTMLElement => screen.getByRole('link', { name })

  it('is a link to the browser, with the sentence’s full stop left out of it', async () => {
    const { port } = await shell()

    await said(port, 'Go to https://blaportal.com/account/notifications. Uncheck the box.')

    const outside = address('https://blaportal.com/account/notifications')
    expect(outside).toHaveAttribute('href', 'https://blaportal.com/account/notifications')
    expect(outside).toHaveAttribute('target', '_blank')
    // The sentence reads exactly as it was written, full stop and all.
    expect(outside.closest('p')).toHaveTextContent(
      'Go to https://blaportal.com/account/notifications. Uncheck the box.'
    )
    expect(outside.nextSibling?.textContent).toBe('. Uncheck the box.')
  })

  it('opens a localhost address as a web tab in the panel', async () => {
    const { port } = await shell()

    await said(port, 'The dev server is up at http://localhost:5173/settings, as asked.')
    await click(link('http://localhost:5173/settings'))

    expect(port.calls).toContainEqual({
      op: 'openAddress',
      args: ['s1', 'http://localhost:5173/settings', { keep: false }]
    })
    expect(tabs()).toEqual(['settings'])
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('leaves out a parenthesis it did not open, and keeps one it did', async () => {
    const { port } = await shell()

    await said(
      port,
      'The docs (at https://example.test/docs) cite https://en.wikipedia.org/wiki/Foo_(bar).'
    )

    expect(address('https://example.test/docs')).toHaveAttribute(
      'href',
      'https://example.test/docs'
    )
    expect(address('https://en.wikipedia.org/wiki/Foo_(bar)')).toHaveAttribute(
      'href',
      'https://en.wikipedia.org/wiki/Foo_(bar)'
    )
  })

  it('is one inside bold and emphasis too', async () => {
    const { port } = await shell()

    await said(port, '**Open https://example.test/now** or _try http://127.0.0.1:8080/_.')

    expect(address('https://example.test/now').closest('strong')).not.toBeNull()
    expect(link('http://127.0.0.1:8080/').closest('em')).not.toBeNull()
  })

  it('needs its scheme, and only http or https will do', async () => {
    const { port } = await shell()

    await said(port, 'Not www.example.test, not ftp://example.test/file, not mailto:a@b.test.')

    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button', { name: /example/ })).toBeNull()
  })

  it('is a link in backticks too, and keeps the code chip’s look', async () => {
    const { port, workspace } = await shell()

    await said(port, 'Fetch `https://example.test/api` or `http://localhost:5173/`.')

    const outside = address('https://example.test/api')
    expect(outside).toHaveAttribute('target', '_blank')
    expect(outside.querySelector('code')).toHaveTextContent('https://example.test/api')

    const local = link('http://localhost:5173/')
    expect(local).toHaveClass('pathlink', 'code')
    await click(local)
    expect(tabs()).toEqual(['localhost'])

    // An address is never a path, so no answer about one is asked of the disk.
    const asked = workspace.calls
      .filter((call) => call.op === 'existingFiles')
      .flatMap((call) => call.args[1] as readonly string[])
    expect(asked).toEqual([])
  })

  it('is recognized as text and never interpreted as markup', async () => {
    const { port } = await shell()

    await said(port, 'See https://example.test/<b>x</b>"onclick="alert(1) now.')

    expect(address('https://example.test/')).toHaveAttribute('href', 'https://example.test/')
    const transcript = screen.getByRole('log', { name: 'Transcript' })
    expect(transcript.querySelector('b')).toBeNull()
    expect(transcript.querySelector('[onclick]')).toBeNull()
  })
})

// Every live target reads as one before the pointer reaches it; a code span
// that names nothing keeps the look it always had.
describe('what a live target looks like', () => {
  it('is drawn as a link, and a dead code span as plain code', async () => {
    const { port } = await shell()

    await said(
      port,
      'Edit `CONTEXT.md`, not `service_request.submitted`; read [the glossary](CONTEXT.md) ' +
        'and https://example.test/.'
    )

    expect(link('CONTEXT.md')).toHaveClass('pathlink', 'code')
    expect(link('the glossary')).toHaveClass('pathlink', 'link')
    expect(screen.getByRole('link', { name: 'https://example.test/' }).closest('.markdown')).not.toBeNull()

    const dead = screen.getByText('service_request.submitted')
    expect(dead.tagName).toBe('CODE')
    expect(dead.className).toBe('')
    expect(dead.closest('a, button')).toBeNull()
  })
})

// Outside the chat a bare address is a link as well, and a local one still
// opens in the panel; a path there is text, as it always was.
describe('a bare web address outside the chat', () => {
  it('opens a local one from a markdown exhibit in the panel, and links no path', async () => {
    const port = createScriptedPort(
      oneSession({
        panel: {
          tabs: [
            {
              id: 'plan',
              title: 'the plan',
              kind: 'markdown',
              shownAt: '2026-08-19T14:14:00.000Z',
              path: '/repos/crucible/docs/plan.md'
            }
          ],
          activeTabId: 'plan'
        }
      })
    )
    port.exhibits.set(
      'plan',
      'Serve it at http://localhost:4000/ and read https://example.test/ and `CONTEXT.md`.'
    )
    render(
      <Shell
        port={port}
        workspace={createScriptedWorkspace(FILES)}
        commands={createScriptedCommands()}
      />
    )
    await sessionsShown()
    await settled()

    const panel = screen.getByLabelText('Context panel')
    expect(within(panel).getByRole('link', { name: 'https://example.test/' })).toHaveAttribute(
      'target',
      '_blank'
    )
    expect(within(panel).getByText('CONTEXT.md').tagName).toBe('CODE')

    await click(within(panel).getByRole('button', { name: 'http://localhost:4000/' }))
    expect(port.calls).toContainEqual({
      op: 'openAddress',
      args: ['s1', 'http://localhost:4000/', { keep: false }]
    })
  })
})

// A markdown file in the panel links to the files beside it, the way a wiki
// does, and its front matter is metadata rather than the first paragraph.
describe('a written link in a markdown document', () => {
  it('opens the file beside the document, and leaves a dead one as written', async () => {
    const port = createScriptedPort(
      oneSession({
        panel: {
          tabs: [
            {
              id: 'wiki',
              title: 'INDEX.md',
              kind: 'markdown',
              shownAt: '2026-08-19T14:14:00.000Z',
              path: '/elsewhere/wiki/kairos/INDEX.md'
            }
          ],
          activeTabId: 'wiki'
        }
      })
    )
    port.exhibits.set(
      'wiki',
      [
        '---',
        'title: Kairos',
        'read_when: "Read when the task touches Kairos"',
        '---',
        '# Kairos',
        '',
        '- [Messaging](messaging/INDEX.md): producers and consumers.',
        '- [Glossary](../glossary.md#hard): the labels.',
        '- [Gone](gone.md): never written.',
        '- Run `CONTEXT.md` as an example.'
      ].join('\n')
    )
    const workspace = createScriptedWorkspace(FILES)
    workspace.elsewhere = [
      '/elsewhere/wiki/kairos/messaging/INDEX.md',
      '/elsewhere/wiki/glossary.md'
    ]
    render(<Shell port={port} workspace={workspace} commands={createScriptedCommands()} />)
    await sessionsShown()
    await settled()

    const panel = screen.getByLabelText('Context panel')
    expect(within(panel).getByText('read_when').tagName).toBe('DT')
    expect(within(panel).getByText('Read when the task touches Kairos').tagName).toBe('DD')
    expect(within(panel).queryByRole('separator')).toBeNull()

    expect(within(panel).getByRole('button', { name: 'Messaging' })).toHaveClass(
      'pathlink',
      'link'
    )
    expect(within(panel).getByText(/\[Gone\]\(gone\.md\)/)).toBeInTheDocument()
    expect(within(panel).getByText('CONTEXT.md').tagName).toBe('CODE')

    await click(within(panel).getByRole('button', { name: 'Glossary' }))
    expect(opens(port)).toEqual([
      ['s1', '/elsewhere/wiki/glossary.md', { keep: false, view: { kind: 'rendered' } }]
    ])
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
