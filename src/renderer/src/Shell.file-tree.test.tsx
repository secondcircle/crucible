// @vitest-environment jsdom
//
// The file viewer as a person meets it: ⌘E swaps the sidebar column to the
// Files face, a click there opens a tab in the session's context panel. The
// tree's entries come from the workspace service; every tab comes from the
// port, and nothing here reads a file.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import { Shell } from './Shell'
import { runningOn } from './keys'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace, type ScriptedWorkspace } from './testing/scripted-workspace'
import { createScriptedCommands } from './testing/scripted-commands'
import { sessionRows, sessionsShown } from './testing/sidebar'
import { settled } from './testing/settled'

const FILES: readonly string[] = [
  '.gitignore',
  'AGENTS.md',
  'docs/design/mock-a-ember.html',
  'package.json',
  'src/renderer/Shell.tsx',
  'src/state/panel-view.ts'
]

async function shell(
  snapshot: Partial<ShellSnapshot> = oneSession(),
  /** Anything the test wants set on the service before the first render. */
  arrange: (workspace: ScriptedWorkspace) => void = () => {}
): Promise<{ port: ScriptedPort; workspace: ScriptedWorkspace }> {
  const hasSessions = (snapshot.sessions ?? []).length > 0
  runningOn('darwin')
  const port = createScriptedPort(snapshot)
  port.models = [{ id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off'] }]
  port.exhibits.set('panel-view', "export const view = 'split'\nexport const other = 2\n")
  const workspace = createScriptedWorkspace(FILES)
  workspace.changed = {
    'src/state/panel-view.ts': 'modified',
    'docs/design/mock-a-ember.html': 'untracked'
  }
  arrange(workspace)
  render(<Shell port={port} workspace={workspace} commands={createScriptedCommands()} />)
  if (hasSessions) await sessionsShown()
  await settled()
  return { port, workspace }
}

async function pressChord(key: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(document, { key, metaKey: true })
  })
}

const treeRows = (): string[] =>
  screen.queryAllByRole('treeitem').map((row) => row.getAttribute('aria-label') ?? '')

const row = (name: string): HTMLElement => screen.getByRole('treeitem', { name })

async function filterFor(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Filter files'), { target: { value: text } })
  })
}

const tabs = (): string[] =>
  screen.queryAllByRole('tab').map((tab) => tab.querySelector('.ttitle')?.textContent ?? '')

/** The preview tab as both the eye and a screen reader find it. */
const previewTabs = (): string[] =>
  screen
    .queryAllByRole('tab')
    .filter((tab) => tab.classList.contains('preview'))
    .map((tab) => tab.getAttribute('aria-label') ?? '')

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

describe('the two faces of the sidebar column', () => {
  it('shows the sessions until ⌘E, and the tree after it', async () => {
    await shell()

    expect(sessionRows().length).toBeGreaterThan(0)
    expect(screen.queryByRole('tree', { name: 'Files' })).toBeNull()

    await pressChord('e')

    expect(screen.getByRole('tree', { name: 'Files' })).not.toBeNull()
    expect(sessionRows()).toEqual([])
    // Nothing else on screen moved: the chat and the composer are where they
    // were, because the tree took the sidebar and nothing more.
    expect(screen.getByLabelText('Message')).not.toBeNull()
  })

  it('swaps back on ⌘E, and on Escape with the tree focused', async () => {
    await shell()

    await pressChord('e')
    await pressChord('e')
    expect(sessionRows().length).toBeGreaterThan(0)

    await pressChord('e')
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText('Filter files'), { key: 'Escape' })
    })

    expect(screen.queryByRole('tree', { name: 'Files' })).toBeNull()
    expect(sessionRows().length).toBeGreaterThan(0)
  })

  it('spells the chord the way this platform does, on the control that switches', async () => {
    await shell()

    expect(screen.getByRole('button', { name: /Files/ }).textContent).toBe('Files ⌘E')

    runningOn('win32')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Files/ }))
    })

    expect(screen.getByRole('button', { name: /Files/ }).textContent).toBe('Files Ctrl+E')
  })

  it('switches by click, either way', async () => {
    await shell()

    await click(screen.getByRole('button', { name: /Files/ }))
    expect(screen.getByRole('tree', { name: 'Files' })).not.toBeNull()

    await click(screen.getByRole('button', { name: 'Sessions' }))
    expect(sessionRows().length).toBeGreaterThan(0)
  })

  it('leaves the cache, quota and version strips exactly where they were', async () => {
    await shell()
    const feet = document.querySelectorAll('.side .sidefoot').length

    await pressChord('e')
    await pressChord('e')

    expect(document.querySelectorAll('.side .sidefoot').length).toBe(feet)
  })
})

describe('the tree', () => {
  it('is rooted at the session’s directory and lists what the service answered', async () => {
    const { workspace } = await shell()

    await pressChord('e')

    expect(workspace.calls).toContainEqual({ op: 'fileTree', args: ['/repos/crucible'] })
    expect(treeRows()).toEqual([
      'docs (holds changes)',
      'src (holds changes)',
      '.gitignore',
      'AGENTS.md',
      'package.json'
    ])
    expect(document.querySelector('.filetree .troot b')?.textContent).toBe('crucible')
  })

  // The window between asking for a watch and the watch running is the window
  // an agent writes in. A listing taken inside it holds neither the file nor a
  // reason to read again, so the tree is wrong until something else asks.
  it('takes its listing only once the watch is running', async () => {
    const { workspace } = await shell(oneSession(), (scripted) => {
      scripted.holdWatch = true
    })

    await pressChord('e')
    expect(workspace.watching).toEqual(['/repos/crucible'])
    expect(workspace.calls.filter((call) => call.op === 'fileTree')).toEqual([])

    // Written while the watch was starting: no event will ever name it.
    workspace.files = [...FILES, 'src/written-while-starting.ts']
    await act(async () => {
      workspace.settleWatch()
    })
    await settled()

    await click(row('src (holds changes)'))
    expect(treeRows()).toContain('written-while-starting.ts')
  })

  it('colors what git changed, and marks the folders holding it', async () => {
    await shell()

    await pressChord('e')
    await click(row('src (holds changes)'))
    await click(row('state (holds changes)'))

    expect(row('src (holds changes)')).toHaveClass('holds')
    expect(row('panel-view.ts (modified)')).toHaveClass('modified')
    await click(row('docs (holds changes)'))
    await click(row('design (holds changes)'))
    expect(row('mock-a-ember.html (untracked)')).toHaveClass('untracked')
  })

  it('shows a worktree session’s worktree, marked as one', async () => {
    await shell(
      oneSession({ worktree: { path: '/repos/crucible/.crucible/worktrees/run-4f2' } })
    )

    await pressChord('e')

    expect(document.querySelector('.filetree .troot .wt')?.textContent).toBe(
      'worktree · run-4f2'
    )
  })

  it('narrows to what the filter matches, opened down to the file', async () => {
    await shell()

    await pressChord('e')
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Filter files'), { target: { value: 'panel' } })
    })

    expect(treeRows()).toEqual([
      'src (holds changes)',
      'state (holds changes)',
      'panel-view.ts (modified)'
    ])
  })

  it('opens and closes a folder, and remembers which are open across a swap', async () => {
    await shell()

    await pressChord('e')
    await click(row('docs (holds changes)'))
    expect(treeRows()).toContain('design (holds changes)')

    await pressChord('e')
    await pressChord('e')
    expect(treeRows()).toContain('design (holds changes)')

    await click(row('docs (holds changes)'))
    expect(treeRows()).not.toContain('design (holds changes)')
  })

  // The chevron is drawn, the row hovers and the click is taken, so a folder
  // row under a filter is a control like any other and must answer like one.
  it('answers a folder click while a filter is on', async () => {
    await shell()

    await pressChord('e')
    await filterFor('panel')
    const before = treeRows()

    await click(row('src (holds changes)'))

    expect(treeRows()).not.toEqual(before)
    expect(treeRows()).toEqual(['src (holds changes)'])
    expect(row('src (holds changes)').getAttribute('aria-expanded')).toBe('false')

    await click(row('src (holds changes)'))
    expect(treeRows()).toEqual(before)
  })

  it('leaves the tree the filter hid arranged as the user left it', async () => {
    await shell()

    await pressChord('e')
    const arranged = treeRows()

    await filterFor('panel')
    await click(row('src (holds changes)'))
    await filterFor('')

    // The fold belonged to the filtered tree and went with it: clearing the
    // filter gives back the tree the user had, not one they never arranged.
    expect(treeRows()).toEqual(arranged)
  })

  it('copies a row’s path and reveals it through the workspace service', async () => {
    const { workspace } = await shell()
    const copied: string[] = []
    Object.assign(navigator, {
      clipboard: {
        writeText: (text: string) => {
          copied.push(text)
          return Promise.resolve()
        }
      }
    })

    await pressChord('e')
    await click(screen.getByRole('button', { name: 'Copy path of AGENTS.md' }))
    // The copy says so where it happened, in the frame it happened.
    expect(screen.getByRole('button', { name: 'Copied the path of AGENTS.md' })).not.toBeNull()
    await click(screen.getByRole('button', { name: 'Reveal AGENTS.md' }))

    // The whole path, which is what the panel header's copy hands over for
    // the same file.
    expect(copied).toEqual(['/repos/crucible/AGENTS.md'])
    expect(workspace.calls).toContainEqual({
      op: 'revealFile',
      args: ['/repos/crucible', 'AGENTS.md']
    })
  })
})

describe('a click in the tree', () => {
  it('opens the file as this session’s preview tab, through the port', async () => {
    const { port } = await shell()

    await pressChord('e')
    await click(row('AGENTS.md'))

    expect(port.calls).toContainEqual({
      op: 'openFile',
      // Everything the tree opens opens as source, on no line in particular.
      args: ['s1', 'AGENTS.md', { keep: false, view: { kind: 'source' } }]
    })
    expect(tabs()).toEqual(['AGENTS.md'])
    expect(previewTabs()).toEqual(['AGENTS.md (preview)'])
  })

  it('replaces the preview tab’s file rather than opening a second tab', async () => {
    await shell()

    await pressChord('e')
    await click(row('AGENTS.md'))
    await click(row('package.json'))

    expect(tabs()).toEqual(['package.json'])
    expect(previewTabs()).toEqual(['package.json (preview)'])
  })

  it('keeps the file when the click is a double one', async () => {
    await shell()

    await pressChord('e')
    await doubleClick(row('AGENTS.md'))
    await click(row('package.json'))

    expect(tabs()).toEqual(['AGENTS.md', 'package.json'])
    expect(previewTabs()).toEqual(['package.json (preview)'])
  })

  // What review-3 found live: the double-click used to send a second open
  // alongside the click's, and whichever answered first decided the panel.
  it('sends the double-click as one decision about the tab the click opened', async () => {
    const { port } = await shell()

    await pressChord('e')
    await click(row('package.json'))
    await doubleClick(row('AGENTS.md'))

    // The preview tab was replaced in place and then kept: one tab, where the
    // previewed file was, and no preview left over.
    expect(tabs()).toEqual(['AGENTS.md'])
    expect(previewTabs()).toEqual([])
    // Three clicks, three previews: the double-click's own press opens
    // nothing of its own.
    const opens = port.calls.filter((call) => call.op === 'openFile')
    expect(opens.map((call) => call.args[2])).toEqual([
      { keep: false, view: { kind: 'source' } },
      { keep: false, view: { kind: 'source' } },
      { keep: false, view: { kind: 'source' } }
    ])
    expect(port.calls.filter((call) => call.op === 'keepTab')).toHaveLength(1)
  })

  it('opens a row outright on Enter, leaving the preview tab alone', async () => {
    await shell()

    await pressChord('e')
    await click(row('package.json'))
    await act(async () => {
      fireEvent.keyDown(row('AGENTS.md'), { key: 'Enter' })
    })

    expect(tabs()).toEqual(['package.json', 'AGENTS.md'])
    expect(previewTabs()).toEqual(['package.json (preview)'])
  })

  it('marks the row of the file the panel is showing', async () => {
    await shell()

    await pressChord('e')
    await click(row('AGENTS.md'))

    expect(row('AGENTS.md')).toHaveClass('on')
    expect(row('package.json')).not.toHaveClass('on')
  })

  it('says where a file would go when there is no session to put it in', async () => {
    await shell({
      workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
      activeWorkspaceId: 'w1',
      sessions: [],
      activeSessionId: undefined
    })

    await pressChord('e')
    await click(row('AGENTS.md'))

    expect(screen.getByRole('alert').textContent).toMatch(/Open a session first/)
    expect(tabs()).toEqual([])
  })
})

describe('the file the panel is showing', () => {
  it('shows it as numbered source, with its line count in the header', async () => {
    await shell()

    await pressChord('e')
    await click(row('src (holds changes)'))
    await click(row('state (holds changes)'))
    await click(row('panel-view.ts (modified)'))

    expect(document.querySelectorAll('.exhibit .src .ln')).toHaveLength(2)
    expect(document.querySelector('.where .lines')?.textContent).toBe('2 lines')
  })

  it('re-reads it when the directory changes on disk', async () => {
    const { port, workspace } = await shell()

    await pressChord('e')
    await click(row('src (holds changes)'))
    await click(row('state (holds changes)'))
    await click(row('panel-view.ts (modified)'))
    const readsBefore = port.calls.filter((call) => call.op === 'exhibit').length

    port.exhibits.set('panel-view', 'changed on disk\n')
    await act(async () => {
      workspace.filesChanged('/repos/crucible')
    })
    await settled()

    expect(port.calls.filter((call) => call.op === 'exhibit').length).toBe(readsBefore + 1)
    expect(document.querySelector('.exhibit .src')?.textContent).toContain('changed on disk')
  })

  // One watch for the session, not one per surface that reads the disk: the
  // tree, an open file tab and the paths an agent names in chat all follow the
  // same directory, and the last of those is read with the column on its
  // other face.
  it('watches the session’s directory for as long as the session is up', async () => {
    const { workspace } = await shell()

    expect(workspace.watching).toEqual(['/repos/crucible'])

    await pressChord('e')
    expect(workspace.watching).toEqual(['/repos/crucible'])

    await click(row('AGENTS.md'))
    await pressChord('e')
    // The face went back to the sessions, and the open file still follows the
    // disk.
    expect(workspace.watching).toEqual(['/repos/crucible'])
  })

  it('flips between source and the rendered view, through the port', async () => {
    const { port } = await shell()
    port.exhibits.set('agents', '# Crucible\n')

    await pressChord('e')
    await click(row('AGENTS.md'))
    expect(document.querySelector('.exhibit .src')).not.toBeNull()

    await click(screen.getByRole('button', { name: 'Show rendered' }))

    expect(port.calls).toContainEqual({ op: 'setTabSource', args: ['s1', 'agents', false] })
    expect(document.querySelector('.exhibit .mdview')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Show source' })).not.toBeNull()
  })

  it('shows a file that is not text by its size alone', async () => {
    const { port } = await shell()
    port.binaries.set('package.json', 921_600)

    await pressChord('e')
    await click(row('package.json'))

    expect(document.querySelector('.exhibit')?.textContent).toBe(
      'Binary file, 900 KB. Crucible shows text, images and pages.'
    )
    expect(document.querySelector('.where .lines')).toBeNull()
  })
})
