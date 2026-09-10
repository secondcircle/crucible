// @vitest-environment jsdom
//
// The address row as a person meets it, driven entirely through the port:
// nothing here reads a file, and the only thing the renderer knows about a
// location is what the snapshot carried.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanelTab, ShellSnapshot } from '../../shared/agent/port'
import { Shell } from './Shell'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedWorkflowRuns } from './testing/scripted-workflow-runs'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { sessionRows, sessionsShown } from './testing/sidebar'
import { settled } from './testing/settled'

const SHOWN = '2026-09-01T09:00:00.000Z'

const BRIEF_PATH = '/repos/crucible/.crucible/worktrees/run-47c8/.crucible/align/260828-addons.md'

const BRIEF: PanelTab = {
  id: 'addons',
  title: 'Alignment brief — Add-ons',
  kind: 'markdown',
  shownAt: SHOWN,
  path: BRIEF_PATH
}

const MOCK: PanelTab = {
  id: 'extras-mobile-v3',
  title: 'Extras step — mobile mock v3',
  kind: 'html',
  shownAt: SHOWN,
  path: '/repos/crucible/.crucible/align/extras-mobile-v3.html'
}

const DEV_SERVER: PanelTab = {
  id: 'extras',
  title: 'Extras step — dev server',
  kind: 'url',
  shownAt: SHOWN,
  address: 'http://localhost:5241/extras'
}

const copied: string[] = []

beforeAll(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async (text: string) => void copied.push(text) },
    configurable: true
  })
})

beforeEach(() => {
  copied.length = 0
})

function withTabs(tabs: readonly PanelTab[], activeTabId: string): Partial<ShellSnapshot> {
  return oneSession({ panel: { tabs, activeTabId } })
}

async function shellWith(
  snapshot: Partial<ShellSnapshot>,
  options: { readonly runs?: boolean } = {}
): Promise<ScriptedPort> {
  const port = createScriptedPort(snapshot)
  port.exhibits.set('addons', '# Alignment — Add-ons\n\nWhat we are building.')
  render(
    <Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
      {...(options.runs === true ? { workflowRuns: createScriptedWorkflowRuns([]) } : {})}
    />
  )
  await sessionsShown()
  await settled()
  return port
}

const row = (): HTMLElement | null => document.querySelector('.ctx .where')
const location = (): HTMLElement => screen.getByRole('button', { name: 'Copy location' })
const refresh = (): HTMLElement => screen.getByRole('button', { name: 'Refresh exhibit' })
const glyph = (): HTMLElement | null => document.querySelector('.ctx .where .refresh .glyph')
const guest = (): HTMLElement | null => document.querySelector('.exhibit webview')
const ops = (port: ScriptedPort): string[] => port.calls.map((call) => call.op)
const reads = (port: ScriptedPort): number => ops(port).filter((op) => op === 'exhibit').length

const shown = (): string => location().textContent?.replace('copied', '') ?? ''

/** jsdom knows nothing of a <webview>, so the guest is given the one method the panel calls. */
function reloadable(): string[] {
  const calls: string[] = []
  const mounted = guest() as (HTMLElement & { reload?: () => void }) | null
  if (mounted === null) throw new Error('there is no guest to reload')
  mounted.reload = () => calls.push('reload')
  return calls
}

async function navigate(url: string): Promise<void> {
  const mounted = guest()
  if (mounted === null) throw new Error('there is no guest to navigate')
  await act(async () => {
    mounted.dispatchEvent(Object.assign(new Event('did-navigate'), { url }))
  })
}

describe('where the row is', () => {
  it('sits between the tab strip and the exhibit, one of it whatever is open', async () => {
    await shellWith(withTabs([BRIEF, MOCK, DEV_SERVER], 'addons'))

    const children = [...(screen.getByLabelText('Context panel').children as unknown as Element[])]
    expect(children.map((child) => child.className)).toEqual(['tabstrip', 'where', 'exhibit'])
    expect(document.querySelectorAll('.ctx .where')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Copy location' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Refresh exhibit' })).toHaveLength(1)
  })

  it('is not there at all for a session with no tabs', async () => {
    await shellWith(oneSession())

    expect(row()).toBeNull()
  })

  it('goes away with the panel, leaving the edge strip nothing but the count', async () => {
    await shellWith(withTabs([BRIEF, MOCK], 'addons'))
    expect(row()).not.toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Collapse context panel' }))
    })

    expect(row()).toBeNull()
    expect(screen.getByRole('button', { name: 'Open context panel' })).toHaveTextContent('2')
  })
})

describe('what the row shows', () => {
  it('names a markdown exhibit by the absolute path the session read it from', async () => {
    await shellWith(withTabs([BRIEF], 'addons'))

    expect(shown()).toBe(BRIEF_PATH)
    expect(shown()).not.toContain('file:')
    expect(shown()).not.toContain('~')
  })

  it('names an html exhibit exactly the way it names a markdown one', async () => {
    await shellWith(withTabs([MOCK], 'extras-mobile-v3'))

    expect(shown()).toBe('/repos/crucible/.crucible/align/extras-mobile-v3.html')
  })

  it('names a web tab by its full address, scheme included', async () => {
    await shellWith(withTabs([DEV_SERVER], 'extras'))

    expect(shown()).toBe('http://localhost:5241/extras')
  })

  it('draws the location in two parts, the one that stays being the emphasized one', async () => {
    await shellWith(withTabs([BRIEF], 'addons'))

    const lead = location().querySelector('.head')
    const tail = location().querySelector('.tail')
    expect(lead?.textContent).toBe('/repos/crucible/.crucible/worktrees/run-47c8/.crucible/align/')
    expect(tail?.textContent).toBe('260828-addons.md')
    // The filename is the bold one; the directory before it is the quieter.
    expect(tail?.tagName).toBe('B')
  })

  it('shows what the port said, having resolved and checked nothing itself', async () => {
    const nowhere: PanelTab = { ...BRIEF, path: '/nowhere/at/all/invented.md' }
    const port = await shellWith(withTabs([nowhere], 'addons'))

    expect(shown()).toBe('/nowhere/at/all/invented.md')
    expect([...new Set(ops(port))].sort()).toEqual([
      'exhibit',
      'listModels',
      'snapshot',
      'transcript'
    ])
  })
})

describe('which tab the row follows', () => {
  it('follows the user clicking another tab', async () => {
    await shellWith(withTabs([BRIEF, DEV_SERVER], 'addons'))

    await act(async () => {
      fireEvent.click(screen.getAllByRole('tab')[1])
    })

    expect(shown()).toBe('http://localhost:5241/extras')
  })

  it('follows an agent show, and a re-show of the tab already open', async () => {
    const port = await shellWith(withTabs([BRIEF], 'addons'))

    await act(async () => {
      port.showTab('s1', MOCK)
    })
    expect(shown()).toBe('/repos/crucible/.crucible/align/extras-mobile-v3.html')

    await act(async () => {
      port.showTab('s1', { ...MOCK, path: '/repos/crucible/.crucible/align/mock-v4.html' })
    })
    expect(shown()).toBe('/repos/crucible/.crucible/align/mock-v4.html')
  })

  it('follows a close that moves the active tab elsewhere', async () => {
    await shellWith(withTabs([BRIEF, DEV_SERVER], 'extras'))
    expect(shown()).toBe('http://localhost:5241/extras')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close Extras step — dev server' }))
    })

    expect(shown()).toBe(BRIEF_PATH)
  })

  it('is per-session: a background show never touches the row on screen', async () => {
    const port = await shellWith({
      workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
      activeWorkspaceId: 'w1',
      activeSessionId: 's1',
      sessions: [
        {
          id: 's1',
          workspaceId: 'w1',
          createdAt: SHOWN,
          working: false,
          fresh: false,
          panel: { tabs: [BRIEF], activeTabId: 'addons' }
        },
        {
          id: 's2',
          workspaceId: 'w1',
          createdAt: SHOWN,
          working: false,
          fresh: false,
          panel: { tabs: [DEV_SERVER], activeTabId: 'extras' }
        }
      ]
    })

    await act(async () => {
      port.showTab('s2', MOCK)
    })
    expect(shown()).toBe(BRIEF_PATH)

    await act(async () => {
      fireEvent.click(sessionRows()[1])
    })
    expect(shown()).toBe('/repos/crucible/.crucible/align/extras-mobile-v3.html')
  })
})

describe('clicking the location', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('copies the whole location, for every kind of tab', async () => {
    await shellWith(withTabs([BRIEF, MOCK, DEV_SERVER], 'addons'))

    for (const [at, whole] of [
      [0, BRIEF_PATH],
      [1, '/repos/crucible/.crucible/align/extras-mobile-v3.html'],
      [2, 'http://localhost:5241/extras']
    ] as const) {
      await act(async () => {
        fireEvent.click(screen.getAllByRole('tab')[at])
      })
      await act(async () => {
        fireEvent.click(location())
      })
      expect(copied.at(-1)).toBe(whole)
    }
  })

  it('copies the whole location, not the two parts the row drew', async () => {
    await shellWith(withTabs([BRIEF], 'addons'))

    await act(async () => {
      fireEvent.click(location())
    })

    const lead = location().querySelector('.head')?.textContent ?? ''
    const tail = location().querySelector('.tail')?.textContent ?? ''
    expect(copied).toEqual([BRIEF_PATH])
    expect(lead + tail).toBe(copied[0])
  })

  it('says so in the row in the click\u2019s own frame, and stops saying it by itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await shellWith(withTabs([BRIEF], 'addons'))

    act(() => {
      fireEvent.click(location())
    })
    expect(location().querySelector('.copied')).toHaveTextContent('copied')

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })

    expect(location().querySelector('.copied')).toBeNull()
    expect(shown()).toBe(BRIEF_PATH)
  })

  it('changes nothing else: no port call, no tab change, no reload, nothing said', async () => {
    const port = await shellWith(withTabs([BRIEF, DEV_SERVER], 'addons'))
    const before = [...port.calls]
    const snapshot = port.snapshotNow

    await act(async () => {
      fireEvent.click(location())
    })

    expect(port.calls).toEqual(before)
    expect(port.snapshotNow).toBe(snapshot)
    expect(screen.getAllByRole('tab')[0]).toHaveAttribute('aria-selected', 'true')
    expect(document.querySelector('.transcript')?.textContent ?? '').not.toContain(BRIEF_PATH)
  })

  // No user-event in this repository, and jsdom fires no click for a key: what
  // is checked is that the control is the kind a browser activates from the
  // keyboard, and that it takes focus like the strip's own controls.
  it('is a real button that takes focus, named for what it does', async () => {
    await shellWith(withTabs([BRIEF], 'addons'))

    expect(location().tagName).toBe('BUTTON')
    expect(location()).not.toBeDisabled()
    expect(location()).not.toHaveAttribute('tabindex')
    location().focus()
    expect(document.activeElement).toBe(location())
  })
})

describe('the refresh control', () => {
  it('is there for every kind of tab, and is the panel\u2019s only one', async () => {
    for (const [tab, active] of [
      [BRIEF, 'addons'],
      [MOCK, 'extras-mobile-v3'],
      [DEV_SERVER, 'extras']
    ] as const) {
      await shellWith(withTabs([tab], active))
      expect(screen.getAllByRole('button', { name: 'Refresh exhibit' })).toHaveLength(1)
      const tools = document.querySelector('.ctx .strip-tools')
      expect(
        [...(tools?.querySelectorAll('button') ?? [])].map((found) =>
          found.getAttribute('aria-label')
        )
      ).toEqual(['Maximize context panel', 'Collapse context panel'])
      cleanup()
    }
  })

  it('is a real button that takes focus, named for what it does', async () => {
    await shellWith(withTabs([BRIEF], 'addons'))

    expect(refresh().tagName).toBe('BUTTON')
    expect(refresh()).not.toBeDisabled()
    refresh().focus()
    expect(document.activeElement).toBe(refresh())
  })

  it('re-reads a markdown file, and shows what it says now under the same tab', async () => {
    const port = await shellWith(withTabs([BRIEF], 'addons'))
    expect(reads(port)).toBe(1)

    port.exhibits.set('addons', '# Alignment — Add-ons\n\nRevised while you read it.')
    await act(async () => {
      fireEvent.click(refresh())
    })
    await settled()

    expect(reads(port)).toBe(2)
    expect(document.querySelector('.exhibit .markdown')).toHaveTextContent(
      'Revised while you read it.'
    )
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(shown()).toBe(BRIEF_PATH)
  })

  it('never paints an older read over a newer one', async () => {
    const port = await shellWith(withTabs([BRIEF], 'addons'))
    const waiting: ((body: string) => void)[] = []
    port.exhibit = () =>
      new Promise((resolve) => waiting.push((body) => resolve({ body })))

    await act(async () => {
      fireEvent.click(refresh())
    })
    await act(async () => {
      fireEvent.click(refresh())
    })
    expect(waiting).toHaveLength(2)

    await act(async () => {
      waiting[1]('# the second read')
      waiting[0]('# the first read')
    })
    await settled()

    expect(screen.getByRole('heading', { name: 'the second read' })).toBeInTheDocument()
  })

  it('reloads an html guest in place, without remounting it or touching its src', async () => {
    const port = await shellWith(withTabs([MOCK], 'extras-mobile-v3'))
    const mounted = guest()
    const src = mounted?.getAttribute('src')
    const reloads = reloadable()

    await act(async () => {
      fireEvent.click(refresh())
    })
    await act(async () => {
      fireEvent.click(refresh())
    })

    expect(reloads).toEqual(['reload', 'reload'])
    expect(guest()).toBe(mounted)
    expect(guest()?.getAttribute('src')).toBe(src)
    expect(guest()?.getAttribute('sandbox')).toBeNull()
    expect(ops(port)).not.toContain('exhibit')
  })

  it('reloads a web guest the same way', async () => {
    await shellWith(withTabs([DEV_SERVER], 'extras'))
    const reloads = reloadable()

    await act(async () => {
      fireEvent.click(refresh())
    })

    expect(reloads).toEqual(['reload'])
  })

  it('spins the glyph on every click, mid-spin ones included', async () => {
    await shellWith(withTabs([BRIEF], 'addons'))
    expect(glyph()).not.toHaveClass('turning')

    await act(async () => {
      fireEvent.click(refresh())
    })
    const first = glyph()
    expect(first).toHaveClass('turning')

    await act(async () => {
      fireEvent.click(refresh())
    })

    // A replaced node is what restarts the animation while it is still running.
    expect(glyph()).not.toBe(first)
    expect(glyph()).toHaveClass('turning')
  })

  it('spins the glyph inside the control, never the control', async () => {
    await shellWith(withTabs([BRIEF], 'addons'))

    await act(async () => {
      fireEvent.click(refresh())
    })

    expect(refresh()).not.toHaveClass('turning')
    expect(glyph()?.parentElement).toBe(refresh())
  })

  it('shows a failed read inline, keeps the tab, and takes the body back later', async () => {
    const port = await shellWith(withTabs([BRIEF], 'addons'))
    port.exhibitRefusal = 'That exhibit could not be read: 260828-addons.md'

    await act(async () => {
      fireEvent.click(refresh())
    })
    await settled()

    expect(
      screen.getByText('That exhibit could not be read: 260828-addons.md')
    ).toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(1)

    port.exhibitRefusal = undefined
    port.exhibits.set('addons', '# It is back')
    await act(async () => {
      fireEvent.click(refresh())
    })
    await settled()

    expect(screen.getByRole('heading', { name: 'It is back' })).toBeInTheDocument()
    expect(screen.queryByText('That exhibit could not be read: 260828-addons.md')).toBeNull()
  })

  it('changes nothing the agent can observe', async () => {
    const port = await shellWith(withTabs([BRIEF, MOCK], 'addons'))
    const before = port.snapshotNow
    const said: string[] = []
    port.onEvent((event) => said.push(event.type))
    const callsBefore = port.calls.length

    await act(async () => {
      fireEvent.click(refresh())
    })
    await settled()

    expect(port.snapshotNow).toBe(before)
    expect(ops(port).slice(callsBefore)).toEqual(['exhibit'])
    expect(said).toEqual([])
    expect(screen.getAllByRole('tab')[0]).toHaveAttribute('aria-selected', 'true')
  })
})

describe('nothing refreshes on its own', () => {
  it('leaves the exhibit alone across a turn, a focus, an activation and time', async () => {
    const port = await shellWith(withTabs([BRIEF], 'addons'))
    const reads0 = reads(port)

    await act(async () => {
      port.update((snapshot) => snapshot)
      port.emit({ type: 'turn_ended', sessionId: 's1', turnId: 't-1' })
      fireEvent.click(screen.getAllByRole('tab')[0])
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    await settled()

    expect(reads(port)).toBe(reads0)

    await act(async () => {
      fireEvent.click(refresh())
    })
    await settled()

    expect(reads(port)).toBe(reads0 + 1)
  })

  it('keeps ⌘R on the runs view, and off the exhibit', async () => {
    const port = await shellWith(withTabs([MOCK], 'extras-mobile-v3'), { runs: true })
    const reloads = reloadable()
    const callsBefore = port.calls.length

    await act(async () => {
      fireEvent.keyDown(document, { key: 'r', metaKey: true })
      await settled()
    })

    expect(screen.getByLabelText('All runs')).toBeInTheDocument()
    expect(reloads).toEqual([])
    expect(ops(port).slice(callsBefore)).not.toContain('exhibit')
  })
})

describe('a web tab\u2019s row follows its guest', () => {
  it('shows where the guest went in place, and copies that', async () => {
    await shellWith(withTabs([DEV_SERVER], 'extras'))

    await navigate('http://localhost:5241/extras/confirm')

    expect(shown()).toBe('http://localhost:5241/extras/confirm')

    await act(async () => {
      fireEvent.click(location())
    })
    expect(copied).toEqual(['http://localhost:5241/extras/confirm'])
  })

  it('changes the row and nothing else', async () => {
    const port = await shellWith(withTabs([BRIEF, DEV_SERVER], 'extras'))
    const before = [...port.calls]
    const titles = screen.getAllByRole('tab').map((tab) => tab.textContent)

    await navigate('http://localhost:5241/extras/confirm')

    expect(port.calls).toEqual(before)
    expect(port.panelOf('s1')?.tabs.map((tab) => tab.id)).toEqual(['addons', 'extras'])
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(titles)
  })

  it('refreshes the page the guest is showing, not the address the agent showed', async () => {
    await shellWith(withTabs([DEV_SERVER], 'extras'))
    const mounted = guest()
    const reloads = reloadable()

    await navigate('http://localhost:5241/extras/confirm')
    await act(async () => {
      fireEvent.click(refresh())
    })

    expect(reloads).toEqual(['reload'])
    expect(guest()).toBe(mounted)
    expect(guest()?.getAttribute('src')).toBe('http://localhost:5241/extras')
  })

  it('leaves a file tab\u2019s row naming the file that was read', async () => {
    await shellWith(withTabs([MOCK], 'extras-mobile-v3'))

    await navigate('http://wandered.example/elsewhere')

    expect(shown()).toBe('/repos/crucible/.crucible/align/extras-mobile-v3.html')
  })

  it('forgets where a guest went as soon as that mount is gone', async () => {
    const port = await shellWith(withTabs([BRIEF, DEV_SERVER], 'extras'))
    await navigate('http://localhost:5241/extras/confirm')

    await act(async () => {
      port.showTab('s1', { ...DEV_SERVER, shownAt: '2026-09-01T10:00:00.000Z' })
    })
    await settled()

    expect(shown()).toBe('http://localhost:5241/extras')
  })

  // Leaving the tab unmounts its guest, and coming back mounts a fresh one at
  // the address the agent showed. The row must not resurrect where the old
  // guest had gone: that is an address the new guest is not displaying, and a
  // copy in that state writes it.
  it('forgets where a guest went across a switch to another tab and back', async () => {
    await shellWith(withTabs([BRIEF, DEV_SERVER], 'extras'))
    const before = guest()
    await navigate('http://localhost:5241/extras/confirm')
    expect(shown()).toBe('http://localhost:5241/extras/confirm')

    await act(async () => {
      fireEvent.click(screen.getAllByRole('tab')[0])
    })
    expect(shown()).toBe(BRIEF_PATH)

    await act(async () => {
      fireEvent.click(screen.getAllByRole('tab')[1])
    })

    expect(guest()).not.toBe(before)
    expect(guest()?.getAttribute('src')).toBe('http://localhost:5241/extras')
    expect(shown()).toBe('http://localhost:5241/extras')

    await act(async () => {
      fireEvent.click(location())
    })
    expect(copied).toEqual(['http://localhost:5241/extras'])
  })

  it('forgets where a guest went across a switch to another session and back', async () => {
    await shellWith({
      workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
      activeWorkspaceId: 'w1',
      activeSessionId: 's1',
      sessions: [
        {
          id: 's1',
          workspaceId: 'w1',
          createdAt: SHOWN,
          working: false,
          fresh: false,
          panel: { tabs: [DEV_SERVER], activeTabId: 'extras' }
        },
        {
          id: 's2',
          workspaceId: 'w1',
          createdAt: SHOWN,
          working: false,
          fresh: false,
          panel: { tabs: [BRIEF], activeTabId: 'addons' }
        }
      ]
    })
    await navigate('http://localhost:5241/extras/confirm')

    await act(async () => {
      fireEvent.click(sessionRows()[1])
    })
    expect(shown()).toBe(BRIEF_PATH)

    await act(async () => {
      fireEvent.click(sessionRows()[0])
    })

    expect(guest()?.getAttribute('src')).toBe('http://localhost:5241/extras')
    expect(shown()).toBe('http://localhost:5241/extras')
  })

  it('forgets where a guest went across a collapse and back', async () => {
    await shellWith(withTabs([DEV_SERVER], 'extras'))
    await navigate('http://localhost:5241/extras/confirm')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Collapse context panel' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open context panel' }))
    })

    expect(guest()?.getAttribute('src')).toBe('http://localhost:5241/extras')
    expect(shown()).toBe('http://localhost:5241/extras')
  })
})

// The row is the same row at any width: a maximized panel changes what it is
// drawn beside, and nothing about what it says or what its controls do.
describe('the row in a maximized panel', () => {
  async function maximize(): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Maximize context panel' }))
    })
  }

  it('sits between the strip and the exhibit, still one of it', async () => {
    await shellWith(withTabs([BRIEF, MOCK, DEV_SERVER], 'addons'))

    await maximize()

    const children = [...(screen.getByLabelText('Context panel').children as unknown as Element[])]
    expect(children.map((child) => child.className)).toEqual(['tabstrip', 'where', 'exhibit'])
    expect(document.querySelectorAll('.ctx .where')).toHaveLength(1)
    expect(shown()).toBe(BRIEF_PATH)
  })

  it('draws the location in the same two parts, the filename last to give way', async () => {
    await shellWith(withTabs([BRIEF], 'addons'))

    await maximize()

    expect(location().querySelector('.head')?.textContent).toBe(
      '/repos/crucible/.crucible/worktrees/run-47c8/.crucible/align/'
    )
    expect(location().querySelector('.tail')?.textContent).toBe('260828-addons.md')
  })

  it('copies the whole location, and says so in the row', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await shellWith(withTabs([BRIEF], 'addons'))
    await maximize()

    act(() => {
      fireEvent.click(location())
    })

    expect(copied).toEqual([BRIEF_PATH])
    expect(location().querySelector('.copied')).toHaveTextContent('copied')

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(location().querySelector('.copied')).toBeNull()
    vi.useRealTimers()
  })

  it('re-reads a markdown file on \u27f3, under the same tab', async () => {
    const port = await shellWith(withTabs([BRIEF], 'addons'))
    await maximize()
    expect(reads(port)).toBe(1)

    port.exhibits.set('addons', '# Alignment \u2014 Add-ons\n\nRevised while you read it.')
    await act(async () => {
      fireEvent.click(refresh())
    })
    await settled()

    expect(reads(port)).toBe(2)
    expect(document.querySelector('.exhibit .markdown')).toHaveTextContent(
      'Revised while you read it.'
    )
    expect(screen.getAllByRole('tab')).toHaveLength(1)
  })

  it('reloads a guest in place, and follows it where it goes', async () => {
    await shellWith(withTabs([DEV_SERVER], 'extras'))
    await maximize()
    const mounted = guest()
    const reloads = reloadable()

    await navigate('http://localhost:5241/extras/confirm')
    expect(shown()).toBe('http://localhost:5241/extras/confirm')

    await act(async () => {
      fireEvent.click(refresh())
    })

    expect(reloads).toEqual(['reload'])
    expect(guest()).toBe(mounted)
  })
})
