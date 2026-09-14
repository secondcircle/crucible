// @vitest-environment node
//
// Both adapters delegate here, so these texts are what a π session and a
// scripted turn both answer with. Real files, because the answers depend on them.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionId } from '../../shared/agent/port'
import {
  createPanelModel,
  memoryPanelPersistence,
  type PanelChange,
  type PanelModel,
  type PanelPersistence,
  type StoredPanel
} from './model'

const SESSION: SessionId = 's1'

let workspace: string
let persistence: PanelPersistence
let saved: Map<SessionId, StoredPanel>
let panel: PanelModel
let changes: PanelChange[]

/** A file that genuinely exists, because that is what `panel_show` checks. */
function file(name: string, body = 'exhibit'): string {
  const path = join(workspace, name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body, 'utf8')
  return path
}

function build(): void {
  panel = createPanelModel({ persistence })
  changes = []
  panel.onChange((change) => changes.push(change))
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'crucible-panel-'))
  saved = new Map()
  persistence = {
    load: (sessionId) => saved.get(sessionId),
    save: (sessionId, state) => {
      saved.set(sessionId, state)
    }
  }
  build()
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('panel_show', () => {
  it('mints a tab from the basename, makes it active, and says what it showed', () => {
    const path = file('storage-options.md')
    const result = panel.show(SESSION, workspace, path, 'storage options')

    expect(result).toBe('Shown in context panel: "storage options"')
    expect(panel.state(SESSION)).toEqual({
      tabs: [
        {
          id: 'storage-options',
          title: 'storage options',
          kind: 'markdown',
          shownAt: expect.any(String),
          path
        }
      ],
      activeTabId: 'storage-options'
    })
  })

  it('refreshes a tab in place when the same path is shown again', () => {
    const path = file('plan.md')
    panel.show(SESSION, workspace, path, 'the plan')
    const first = panel.state(SESSION)

    panel.show(SESSION, workspace, file('other.html'), 'other')
    panel.show(SESSION, workspace, path, 'the accepted plan')
    const after = panel.state(SESSION)

    expect(after?.tabs.map((tab) => tab.id)).toEqual(['plan', 'other'])
    expect(after?.tabs[0].title).toBe('the accepted plan')
    expect(after?.activeTabId).toBe('plan')
    // The refresh is what the view watches for: the tab was shown again.
    expect((after?.tabs[0].shownAt ?? '') >= (first?.tabs[0].shownAt ?? '')).toBe(true)
  })

  it('numbers a colliding slug from -2, and falls back to tab for an empty one', () => {
    panel.show(SESSION, workspace, file('one/plan.md'), 'first')
    panel.show(SESSION, workspace, file('two/plan.md'), 'second')
    panel.show(SESSION, workspace, file('three/plan.md'), 'third')
    panel.show(SESSION, workspace, file('---.md'), 'nameless')

    expect(panel.state(SESSION)?.tabs.map((tab) => tab.id)).toEqual([
      'plan',
      'plan-2',
      'plan-3',
      'tab'
    ])
  })

  it('reads the kind off the extension, .txt included', () => {
    panel.show(SESSION, workspace, file('a.html'), 'a')
    panel.show(SESSION, workspace, file('b.htm'), 'b')
    panel.show(SESSION, workspace, file('c.md'), 'c')
    panel.show(SESSION, workspace, file('d.markdown'), 'd')
    panel.show(SESSION, workspace, file('e.txt'), 'e')

    expect(panel.state(SESSION)?.tabs.map((tab) => tab.kind)).toEqual([
      'html',
      'html',
      'markdown',
      'markdown',
      'markdown'
    ])
  })

  it('resolves a relative path against the session\u2019s workspace folder', () => {
    file('docs/plan.md')

    const result = panel.show(SESSION, workspace, 'docs/plan.md', 'plan')

    expect(result).toBe('Shown in context panel: "plan"')
    expect(panel.state(SESSION)?.tabs[0].id).toBe('plan')
  })

  it('refuses a file that is not there, naming the path it resolved', () => {
    expect(() => panel.show(SESSION, workspace, 'docs/gone.md', 'gone')).toThrow(
      `File not found: ${join(workspace, 'docs/gone.md')}`
    )
    expect(panel.state(SESSION)).toBeUndefined()
  })

  it('refuses an extension it cannot render, and lists what it can', () => {
    expect(() => panel.show(SESSION, workspace, file('notes.pdf'), 'notes')).toThrow(
      'Unsupported file type ".pdf". Supported: .html, .htm, .md, .markdown, .txt, or an http(s) URL'
    )
  })

  it('names the file the same absolute way for both exhibit kinds', () => {
    const page = file('benchmark.html')
    const notes = file('deep/nested/notes.md')
    panel.show(SESSION, workspace, page, 'benchmark')
    panel.show(SESSION, workspace, notes, 'notes')

    const tabs = panel.state(SESSION)?.tabs ?? []
    expect(tabs.map((tab) => (tab.kind === 'url' ? tab.address : tab.path))).toEqual([page, notes])
    expect(JSON.stringify(tabs)).not.toContain('file:')
  })

  it('resolves a relative show against the directory the session works in', () => {
    const worktree = join(workspace, 'worktrees', 'run-47c8')
    file(join('worktrees', 'run-47c8', 'plan.md'))
    file('plan.md')

    panel.show(SESSION, worktree, 'plan.md', 'plan')
    panel.show('s2', workspace, 'plan.md', 'plan')

    const here = panel.state(SESSION)?.tabs[0]
    const there = panel.state('s2')?.tabs[0]
    expect(here?.kind === 'markdown' && here.path).toBe(join(worktree, 'plan.md'))
    expect(there?.kind === 'markdown' && there.path).toBe(join(workspace, 'plan.md'))
  })

  it('carries the whole tab list and the curation nudge once a second tab is open', () => {
    panel.bumpTurn(SESSION)
    panel.show(SESSION, workspace, file('storage-options.md'), 'storage options')
    panel.bumpTurn(SESSION)

    const result = panel.show(SESSION, workspace, file('benchmark.html'), 'benchmark')

    expect(result).toBe(
      [
        'Shown in context panel: "benchmark"',
        'Open tabs:',
        '  1. storage-options — "storage options" (shown 1 turn ago)',
        '  2. benchmark — "benchmark" (shown this turn)',
        'Close tabs that are no longer relevant to the current conversation.'
      ].join('\n')
    )
  })
})

describe('panel_list', () => {
  it('says the panel is empty when it is', () => {
    expect(panel.list(SESSION)).toBe('The context panel is empty.')
  })

  it('numbers the open tabs and ages them by the turn counter', () => {
    panel.show(SESSION, workspace, file('plan.md'), 'plan')
    panel.bumpTurn(SESSION)
    panel.show(SESSION, workspace, file('report.md'), 'report')
    panel.bumpTurn(SESSION)
    panel.bumpTurn(SESSION)
    panel.show(SESSION, workspace, file('now.md'), 'now')

    expect(panel.list(SESSION)).toBe(
      [
        'Open tabs in the context panel:',
        '  1. plan — "plan" (shown 3 turns ago)',
        '  2. report — "report" (shown 2 turns ago)',
        '  3. now — "now" (shown this turn)'
      ].join('\n')
    )
  })
})

describe('panel_close', () => {
  it('closes one tab by id and reports what is left', () => {
    panel.show(SESSION, workspace, file('plan.md'), 'plan')
    panel.show(SESSION, workspace, file('report.md'), 'report')

    const result = panel.close(SESSION, 'report')

    expect(result).toBe(
      'Closed "report". Open tabs in the context panel:\n  1. plan — "plan" (shown this turn)'
    )
    expect(panel.state(SESSION)?.activeTabId).toBe('plan')
  })

  it('hands the active tab to the last one left when the active one closes', () => {
    panel.show(SESSION, workspace, file('first.md'), 'first')
    panel.show(SESSION, workspace, file('second.md'), 'second')
    panel.show(SESSION, workspace, file('third.md'), 'third')
    panel.activate(SESSION, 'first')

    panel.close(SESSION, 'first')

    expect(panel.state(SESSION)?.activeTabId).toBe('third')
  })

  it('closes everything on "all"', () => {
    panel.show(SESSION, workspace, file('plan.md'), 'plan')
    panel.show(SESSION, workspace, file('report.md'), 'report')

    expect(panel.close(SESSION, 'all')).toBe('Closed all tabs. The context panel is empty.')
    expect(panel.state(SESSION)).toBeUndefined()
  })

  it('refuses an id it does not have, and says what is open instead', () => {
    panel.show(SESSION, workspace, file('plan.md'), 'plan')

    expect(() => panel.close(SESSION, 'benchmark')).toThrow(
      'No tab with id "benchmark". Open tabs in the context panel:\n  1. plan — "plan" (shown this turn)'
    )
  })
})

describe('the user\u2019s own actions', () => {
  it('switches and closes through the same state the tools read', () => {
    panel.show(SESSION, workspace, file('plan.md'), 'plan')
    panel.show(SESSION, workspace, file('report.md'), 'report')

    panel.activate(SESSION, 'plan')
    expect(panel.state(SESSION)?.activeTabId).toBe('plan')

    panel.closeTab(SESSION, 'report')
    // The agent learns of it here, at its next list, and nowhere earlier.
    expect(panel.list(SESSION)).toBe(
      'Open tabs in the context panel:\n  1. plan — "plan" (shown this turn)'
    )
  })

  it('does nothing at all for a tab that is no longer open', () => {
    panel.show(SESSION, workspace, file('plan.md'), 'plan')
    changes.length = 0

    panel.activate(SESSION, 'gone')
    panel.closeTab(SESSION, 'gone')

    expect(changes).toEqual([])
    expect(panel.state(SESSION)?.tabs).toHaveLength(1)
  })
})

describe('a web address', () => {
  it('is a tab too: kind url, the address it carries, its id off the host', () => {
    const result = panel.show(SESSION, workspace, 'http://localhost:5173/', 'dev server')

    expect(result).toBe('Shown in context panel: "dev server"')
    expect(panel.state(SESSION)).toEqual({
      tabs: [
        {
          id: 'localhost',
          title: 'dev server',
          kind: 'url',
          shownAt: expect.any(String),
          address: 'http://localhost:5173/'
        }
      ],
      activeTabId: 'localhost'
    })
  })

  it('mints a readable id off the last path piece when one exists', () => {
    panel.show(SESSION, workspace, 'https://example.com/docs/guide', 'the guide')

    expect(panel.state(SESSION)?.tabs[0].id).toBe('guide')
  })

  it('refreshes in place when the same address is shown again', () => {
    panel.show(SESSION, workspace, 'http://localhost:5173/', 'dev server')
    panel.show(SESSION, workspace, 'http://localhost:5173/', 'the dev server')

    expect(panel.state(SESSION)?.tabs).toHaveLength(1)
    expect(panel.state(SESSION)?.tabs[0].title).toBe('the dev server')
  })

  it('has no file to read, and the exhibit body says so', async () => {
    panel.show(SESSION, workspace, 'http://localhost:5173/', 'dev server')

    await expect(panel.exhibit(SESSION, 'localhost')).rejects.toThrow(
      'That tab shows a web address; it has no file to read.'
    )
  })

  it('survives a restore, which checks no disk for it', () => {
    panel.show(SESSION, workspace, 'http://localhost:5173/', 'dev server')

    build()

    expect(panel.state(SESSION)?.tabs[0]).toMatchObject({
      id: 'localhost',
      kind: 'url',
      address: 'http://localhost:5173/'
    })
  })
})

describe('the exhibit body', () => {
  it('reads the file at call time, so a re-show shows what the file says now', async () => {
    const path = file('plan.md', '# first')
    panel.show(SESSION, workspace, path, 'plan')

    await expect(panel.exhibit(SESSION, 'plan')).resolves.toBe('# first')

    writeFileSync(path, '# second', 'utf8')
    await expect(panel.exhibit(SESSION, 'plan')).resolves.toBe('# second')
  })

  it('refuses a tab it does not have, and a file it cannot read', async () => {
    const path = file('plan.md')
    panel.show(SESSION, workspace, path, 'plan')
    rmSync(path)

    await expect(panel.exhibit(SESSION, 'gone')).rejects.toThrow(
      'That tab is no longer in the context panel.'
    )
    await expect(panel.exhibit(SESSION, 'plan')).rejects.toThrow(
      'That exhibit could not be read: plan.md'
    )
  })
})

describe('per session', () => {
  it('keeps two sessions\u2019 tabs apart, and their turn counters with them', () => {
    panel.show(SESSION, workspace, file('plan.md'), 'plan')
    panel.bumpTurn('s2')
    panel.show('s2', workspace, file('other.md'), 'other')

    expect(panel.state(SESSION)?.tabs.map((tab) => tab.id)).toEqual(['plan'])
    expect(panel.state('s2')?.tabs.map((tab) => tab.id)).toEqual(['other'])
    expect(panel.list('s2')).toBe(
      'Open tabs in the context panel:\n  1. other — "other" (shown this turn)'
    )
  })
})

describe('what the change listener hears', () => {
  it('names the tab on a show and says only that the session changed otherwise', () => {
    panel.show(SESSION, workspace, file('plan.md'), 'plan')
    panel.closeTab(SESSION, 'plan')

    expect(changes).toEqual([
      { sessionId: SESSION, shownTabId: 'plan' },
      { sessionId: SESSION }
    ])
  })
})

describe('persistence and restore', () => {
  it('round-trips tabs, the active tab and the turn counter through the seam', () => {
    const path = file('plan.md')
    panel.bumpTurn(SESSION)
    panel.show(SESSION, workspace, path, 'plan')

    expect(saved.get(SESSION)).toEqual({
      tabs: [
        {
          id: 'plan',
          title: 'plan',
          path,
          kind: 'markdown',
          shownAt: expect.any(String),
          shownTurn: 1
        }
      ],
      activeTabId: 'plan',
      previewTabId: null,
      turn: 1
    })

    // A second model over the same seam is what a relaunch is.
    build()
    expect(panel.state(SESSION)?.tabs.map((tab) => tab.id)).toEqual(['plan'])
    expect(panel.list(SESSION)).toBe(
      'Open tabs in the context panel:\n  1. plan — "plan" (shown this turn)'
    )
  })

  it('silently drops a tab whose file vanished, and reseats the active one', () => {
    const gone = file('gone.md')
    const kept = file('kept.md')
    panel.show(SESSION, workspace, kept, 'kept')
    panel.show(SESSION, workspace, gone, 'gone')
    rmSync(gone)

    build()

    expect(panel.state(SESSION)).toEqual({
      tabs: [
        { id: 'kept', title: 'kept', kind: 'markdown', shownAt: expect.any(String), path: kept }
      ],
      activeTabId: 'kept'
    })
    // What was restored is what is written from then on: the store stops
    // holding a path that leads nowhere.
    expect(saved.get(SESSION)?.tabs.map((tab) => tab.id)).toEqual(['kept'])
  })

  it('restores nothing at all when every file is gone', () => {
    const path = file('plan.md')
    panel.show(SESSION, workspace, path, 'plan')
    rmSync(path)

    build()

    expect(panel.state(SESSION)).toBeUndefined()
    expect(panel.list(SESSION)).toBe('The context panel is empty.')
  })

  it('starts empty when the seam holds nothing for the session', () => {
    const fresh = createPanelModel({ persistence: memoryPanelPersistence() })

    expect(fresh.state(SESSION)).toBeUndefined()
    expect(fresh.list(SESSION)).toBe('The context panel is empty.')
  })
})

describe('session lifecycle', () => {
  it('clears the tabs and the turn counter on a reset', () => {
    panel.bumpTurn(SESSION)
    panel.bumpTurn(SESSION)
    panel.show(SESSION, workspace, file('plan.md'), 'plan')

    panel.reset(SESSION)

    expect(panel.state(SESSION)).toBeUndefined()
    expect(saved.get(SESSION)).toEqual({ tabs: [], activeTabId: null, previewTabId: null, turn: 0 })
    // The counter starts over with the conversation it counted.
    panel.show(SESSION, workspace, file('after.md'), 'after')
    expect(panel.list(SESSION)).toBe(
      'Open tabs in the context panel:\n  1. after — "after" (shown this turn)'
    )
  })

  it('forgets a session without writing anything back for it', () => {
    panel.show(SESSION, workspace, file('plan.md'), 'plan')
    const written = saved.get(SESSION)

    panel.forget(SESSION)

    // The persisted copy leaves with the session record; nothing here rewrites
    // it on the way out.
    expect(saved.get(SESSION)).toBe(written)
  })
})

describe('a click in the file tree', () => {
  it('opens any text file as source, titled by its name and keyed by its path', async () => {
    file('src/state/panel-view.ts', 'export const x = 1\n')
    const id = await panel.open(SESSION, workspace, 'src/state/panel-view.ts', { keep: false })

    expect(id).toBe('panel-view')
    expect(panel.state(SESSION)).toEqual({
      tabs: [
        {
          id: 'panel-view',
          title: 'panel-view.ts',
          kind: 'source',
          shownAt: expect.any(String),
          path: join(workspace, 'src/state/panel-view.ts')
        }
      ],
      activeTabId: 'panel-view',
      previewTabId: 'panel-view'
    })
  })

  it('gives a markdown or html file the view its toggle flips to', async () => {
    await panel.open(SESSION, workspace, file('plan.md'), { keep: false })
    await panel.open(SESSION, workspace, file('page.html'), { keep: true })

    expect(panel.state(SESSION)?.tabs.map((tab) => [tab.kind, 'renders' in tab && tab.renders])).toEqual([
      ['source', 'markdown'],
      ['source', 'html']
    ])
  })

  it('shows an image as an image and a file that is not text by its size', async () => {
    writeFileSync(join(workspace, 'shot.png'), 'not really a png', 'utf8')
    writeFileSync(join(workspace, 'thing.bin'), Buffer.from([1, 0, 2, 0, 3]))

    await panel.open(SESSION, workspace, 'shot.png', { keep: true })
    await panel.open(SESSION, workspace, 'thing.bin', { keep: true })

    expect(panel.state(SESSION)?.tabs.map((tab) => tab.kind)).toEqual(['image', 'binary'])
    const binary = panel.state(SESSION)?.tabs[1]
    expect(binary?.kind === 'binary' && binary.bytes).toBe(5)
  })

  it('refuses a file that is not there, naming it', async () => {
    await expect(panel.open(SESSION, workspace, 'gone.ts', { keep: false })).rejects.toThrow(
      /File not found/
    )
  })
})

describe('the preview tab', () => {
  it('is replaced in place by the next single click, and is the only one', async () => {
    await panel.open(SESSION, workspace, file('first.ts'), { keep: true })
    await panel.open(SESSION, workspace, file('second.ts'), { keep: false })
    await panel.open(SESSION, workspace, file('third.ts'), { keep: false })

    expect(panel.state(SESSION)?.tabs.map((tab) => tab.id)).toEqual(['first', 'third'])
    expect(panel.state(SESSION)?.previewTabId).toBe('third')
  })

  // The double-click as the tree sends it: the click opens the file in the
  // preview slot, and the press after it keeps that same tab. One decision
  // about one tab, so the gesture has one outcome whatever the disk does.
  it('is kept in place by the double-click that follows the click', async () => {
    await panel.open(SESSION, workspace, file('previewed.ts'), { keep: false })
    const tabId = await panel.open(SESSION, workspace, file('kept.ts'), { keep: false })

    panel.keep(SESSION, tabId)

    expect(panel.state(SESSION)?.tabs.map((tab) => tab.id)).toEqual(['kept'])
    expect(panel.state(SESSION)?.previewTabId).toBeUndefined()
    expect(saved.get(SESSION)?.previewTabId).toBeNull()
  })

  it('is untouched by a keep aimed at any other tab', async () => {
    panel.show(SESSION, workspace, file('plan.md'), 'the plan')
    await panel.open(SESSION, workspace, file('previewed.ts'), { keep: false })

    panel.keep(SESSION, 'plan')

    expect(panel.state(SESSION)?.previewTabId).toBe('previewed')
  })

  it('is left where it is by a file opened outright, as Enter opens one', async () => {
    await panel.open(SESSION, workspace, file('previewed.ts'), { keep: false })
    await panel.open(SESSION, workspace, file('kept.ts'), { keep: true })

    expect(panel.state(SESSION)?.tabs.map((tab) => tab.id)).toEqual(['previewed', 'kept'])
    expect(panel.state(SESSION)?.previewTabId).toBe('previewed')
  })

  // Clicks queue behind one another, so the panel is decided by the order the
  // user clicked in rather than the order the disk answered in. A click that
  // fails is still one of them and must not take the rest with it.
  it('lets the clicks behind a failed one through, in order', async () => {
    const gone = panel.open(SESSION, workspace, 'gone.ts', { keep: false })
    const first = panel.open(SESSION, workspace, file('first.ts'), { keep: false })
    const second = panel.open(SESSION, workspace, file('second.ts'), { keep: false })

    await expect(gone).rejects.toThrow(/File not found/)
    await Promise.all([first, second])

    expect(panel.state(SESSION)?.tabs.map((tab) => tab.id)).toEqual(['second'])
    expect(panel.state(SESSION)?.previewTabId).toBe('second')
  })

  it('is never a tab the agent showed, even when the agent shows it after', async () => {
    const path = file('plan.md')
    await panel.open(SESSION, workspace, path, { keep: false })
    expect(panel.state(SESSION)?.previewTabId).toBe('plan')

    panel.show(SESSION, workspace, path, 'the plan')

    expect(panel.state(SESSION)?.previewTabId).toBeUndefined()
  })

  it('leaves an open tab showing what it was showing, and lands on it', async () => {
    const path = file('plan.md')
    panel.show(SESSION, workspace, path, 'the plan')
    await panel.open(SESSION, workspace, file('other.ts'), { keep: false })

    await panel.open(SESSION, workspace, path, { keep: false })

    expect(panel.state(SESSION)?.activeTabId).toBe('plan')
    expect(panel.state(SESSION)?.tabs.find((tab) => tab.id === 'plan')?.kind).toBe('markdown')
    expect(panel.state(SESSION)?.previewTabId).toBe('other')
  })

  it('stops being one when its tab closes', async () => {
    await panel.open(SESSION, workspace, file('previewed.ts'), { keep: false })

    panel.closeTab(SESSION, 'previewed')

    expect(panel.state(SESSION)).toBeUndefined()
    expect(saved.get(SESSION)?.previewTabId).toBeNull()
  })
})

describe('the source and rendered toggle', () => {
  it('flips a markdown tab to source and back to what it renders', async () => {
    const path = file('plan.md')
    panel.show(SESSION, workspace, path, 'the plan')

    panel.setSource(SESSION, 'plan', true)
    expect(panel.state(SESSION)?.tabs[0]).toMatchObject({ kind: 'source', renders: 'markdown' })

    panel.setSource(SESSION, 'plan', false)
    expect(panel.state(SESSION)?.tabs[0]?.kind).toBe('markdown')
  })

  it('does nothing for a file with no rendered view of its own', async () => {
    await panel.open(SESSION, workspace, file('port.ts'), { keep: true })

    panel.setSource(SESSION, 'port', false)

    expect(panel.state(SESSION)?.tabs[0]?.kind).toBe('source')
  })

  it('refuses to read a body for what is not text', async () => {
    writeFileSync(join(workspace, 'shot.png'), 'not really a png', 'utf8')
    await panel.open(SESSION, workspace, 'shot.png', { keep: true })

    await expect(panel.exhibit(SESSION, 'shot')).rejects.toThrow(/not text/)
  })
})
