// @vitest-environment node
//
// The tool contract, tested once rather than once per adapter: both adapters
// delegate here, so these texts are what a π session and a scripted turn both
// answer with. Real files in a temp directory, because the model's answers
// depend on what is genuinely on disk.
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
    const result = panel.show(SESSION, workspace, file('storage-options.md'), 'storage options')

    expect(result).toBe('Shown in context panel: "storage options"')
    expect(panel.state(SESSION)).toEqual({
      tabs: [
        {
          id: 'storage-options',
          title: 'storage options',
          kind: 'markdown',
          shownAt: expect.any(String)
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

    // Same id, no second tab, the new title, and the active tab is the one
    // just shown.
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
      'Unsupported file type ".pdf". Supported: .html, .htm, .md, .markdown, .txt'
    )
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

describe('the exhibit body', () => {
  it('reads the file at call time, so a re-show shows what the file says now', () => {
    const path = file('plan.md', '# first')
    panel.show(SESSION, workspace, path, 'plan')

    expect(panel.exhibit(SESSION, 'plan')).toBe('# first')

    writeFileSync(path, '# second', 'utf8')
    expect(panel.exhibit(SESSION, 'plan')).toBe('# second')
  })

  it('refuses a tab it does not have, and a file it cannot read', () => {
    const path = file('plan.md')
    panel.show(SESSION, workspace, path, 'plan')
    rmSync(path)

    expect(() => panel.exhibit(SESSION, 'gone')).toThrow(
      'That tab is no longer in the context panel.'
    )
    expect(() => panel.exhibit(SESSION, 'plan')).toThrow(
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
    panel.show(SESSION, workspace, file('kept.md'), 'kept')
    panel.show(SESSION, workspace, gone, 'gone')
    rmSync(gone)

    build()

    expect(panel.state(SESSION)).toEqual({
      tabs: [{ id: 'kept', title: 'kept', kind: 'markdown', shownAt: expect.any(String) }],
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
    expect(saved.get(SESSION)).toEqual({ tabs: [], activeTabId: null, turn: 0 })
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
