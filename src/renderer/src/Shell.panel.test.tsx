// @vitest-environment jsdom
//
// The panel as a person meets it, driven entirely through the port: nothing
// here reads a file or knows a path.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { exhibitUrl } from '../../shared/agent/exhibit-url'
import type { PanelTab, ShellSnapshot } from '../../shared/agent/port'
import { Shell } from './Shell'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { createScriptedCommands } from './testing/scripted-commands'
import { settled } from './testing/settled'

const SHOWN = '2026-08-19T14:14:00.000Z'

const PLAN: PanelTab = { id: 'plan', title: 'the plan', kind: 'markdown', shownAt: SHOWN }
const BENCHMARK: PanelTab = {
  id: 'benchmark',
  title: 'benchmark',
  kind: 'html',
  shownAt: SHOWN
}

function withTabs(tabs: readonly PanelTab[], activeTabId: string): Partial<ShellSnapshot> {
  return oneSession({ panel: { tabs, activeTabId } })
}

async function shellWith(snapshot: Partial<ShellSnapshot>): Promise<ScriptedPort> {
  const port = createScriptedPort(snapshot)
  port.models = [{ id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off', 'low'] }]
  // Only markdown bodies ride the port: an HTML exhibit is loaded by the frame
  // itself, from the exhibit scheme.
  port.exhibits.set('plan', '# The plan\n\nOne paragraph of it.')
  render(<Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />)
  await screen.findAllByRole('button', { name: /^Session · / })
  await settled()
  return port
}

const region = (): HTMLElement | null => screen.queryByLabelText('Context panel')
const divider = (): HTMLElement | null => screen.queryByLabelText('Resize context panel')
const edge = (): HTMLElement | null => screen.queryByRole('button', { name: 'Open context panel' })
const tabs = (): HTMLElement[] => screen.queryAllByRole('tab')
const frame = (): HTMLIFrameElement | null => document.querySelector('.exhibit iframe')

const ops = (port: ScriptedPort): string[] => port.calls.map((call) => call.op)

describe('a session with no tabs', () => {
  it('shows no panel, no divider and no edge strip at all', async () => {
    await shellWith(oneSession())

    expect(region()).toBeNull()
    expect(divider()).toBeNull()
    expect(edge()).toBeNull()
  })
})

describe('the tab strip', () => {
  it('renders the tabs in show order, with their kind badges', async () => {
    await shellWith(withTabs([PLAN, BENCHMARK], 'plan'))

    expect(tabs().map((tab) => tab.textContent)).toEqual(['mdthe plan×', 'htmlbenchmark×'])
  })

  it('marks the shown tab as the active one', async () => {
    await shellWith(withTabs([PLAN, BENCHMARK], 'benchmark'))

    expect(tabs()[0]).toHaveAttribute('aria-selected', 'false')
    expect(tabs()[1]).toHaveAttribute('aria-selected', 'true')
    expect(tabs()[1]).toHaveClass('active')
  })

  it('sends a click to the port and changes nothing of its own', async () => {
    const port = await shellWith(withTabs([PLAN, BENCHMARK], 'plan'))
    // The port is what decides: with one that answers without a snapshot, the
    // strip stands exactly where it stood.
    const asked: string[] = []
    port.activateTab = (_sessionId, tabId) => {
      asked.push(tabId)
      return Promise.resolve()
    }

    await act(async () => {
      fireEvent.click(tabs()[1])
    })

    expect(asked).toEqual(['benchmark'])
    expect(tabs()[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('switches to the tab the port then reports as active', async () => {
    const port = await shellWith(withTabs([PLAN, BENCHMARK], 'plan'))

    await act(async () => {
      fireEvent.click(tabs()[1])
    })

    expect(port.panelOf('s1')?.activeTabId).toBe('benchmark')
    expect(tabs()[1]).toHaveAttribute('aria-selected', 'true')
  })

  it('closes a tab through the port, and never as a local edit', async () => {
    const port = await shellWith(withTabs([PLAN, BENCHMARK], 'plan'))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close benchmark' }))
    })

    expect(port.calls).toContainEqual({ op: 'closeTab', args: ['s1', 'benchmark'] })
    expect(tabs().map((tab) => tab.textContent)).toEqual(['mdthe plan×'])
  })

  it('takes the whole region away when the last tab closes', async () => {
    await shellWith(withTabs([PLAN], 'plan'))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close the plan' }))
    })

    expect(region()).toBeNull()
    expect(divider()).toBeNull()
    expect(edge()).toBeNull()
  })
})

describe('collapsing', () => {
  it('leaves an edge strip with the tab count, and reopens on a click', async () => {
    await shellWith(withTabs([PLAN, BENCHMARK], 'plan'))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Collapse context panel' }))
    })

    expect(region()).toBeNull()
    expect(divider()).toBeNull()
    expect(edge()).toHaveTextContent('2')

    await act(async () => {
      fireEvent.click(edge() as HTMLElement)
    })

    expect(region()).not.toBeNull()
    expect(edge()).toBeNull()
  })

  it('opens again when the agent shows a tab', async () => {
    const port = await shellWith(withTabs([PLAN], 'plan'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Collapse context panel' }))
    })
    expect(region()).toBeNull()

    await act(async () => {
      port.showTab('s1', BENCHMARK)
    })

    expect(region()).not.toBeNull()
    expect(tabs()).toHaveLength(2)
  })
})

describe('the exhibit', () => {
  it('renders a markdown body through the app\u2019s markdown component', async () => {
    await shellWith(withTabs([PLAN], 'plan'))

    expect(screen.getByRole('heading', { name: 'The plan' })).toBeInTheDocument()
    expect(document.querySelector('.exhibit .markdown p')).toHaveTextContent(
      'One paragraph of it.'
    )
    expect(frame()).toBeNull()
  })

  it('loads an HTML exhibit from its own origin, in a frame that may run scripts and nothing else', async () => {
    const port = await shellWith(withTabs([BENCHMARK], 'benchmark'))

    const shown = frame()
    expect(shown).not.toBeNull()
    expect(shown?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(shown?.getAttribute('src')).toBe(exhibitUrl('s1', 'benchmark'))
    expect(shown?.getAttribute('srcdoc')).toBeNull()
    // Nothing of an HTML exhibit crosses the port: the frame fetches it.
    expect(ops(port)).not.toContain('exhibit')
  })

  it('replaces the frame when a re-show refreshes an HTML tab', async () => {
    const port = await shellWith(withTabs([BENCHMARK], 'benchmark'))
    const first = frame()

    await act(async () => {
      port.showTab('s1', { ...BENCHMARK, shownAt: '2026-08-19T15:00:00.000Z' })
    })
    await settled()

    // A new element, which is what "the frame reloads" looks like from here:
    // the load itself is the browser's, and `no-store` makes it fetch again.
    expect(frame()).not.toBeNull()
    expect(frame()).not.toBe(first)
    expect(frame()?.getAttribute('src')).toBe(exhibitUrl('s1', 'benchmark'))
    expect(ops(port)).not.toContain('exhibit')
  })

  it('fetches the body again when a re-show refreshes the tab', async () => {
    const port = await shellWith(withTabs([PLAN], 'plan'))
    expect(ops(port).filter((op) => op === 'exhibit')).toHaveLength(1)

    port.exhibits.set('plan', '# The accepted plan')
    await act(async () => {
      port.showTab('s1', { ...PLAN, title: 'the accepted plan', shownAt: '2026-08-19T15:00:00.000Z' })
    })
    await settled()

    expect(ops(port).filter((op) => op === 'exhibit')).toHaveLength(2)
    expect(screen.getByRole('heading', { name: 'The accepted plan' })).toBeInTheDocument()
  })

  it('shows a failed read inline, and keeps the tab', async () => {
    const port = createScriptedPort(withTabs([PLAN], 'plan'))
    port.models = []
    port.exhibitRefusal = 'That exhibit could not be read: plan.md'
    render(<Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />)
    await screen.findAllByRole('button', { name: /^Session · / })
    await settled()

    expect(screen.getByText('That exhibit could not be read: plan.md')).toBeInTheDocument()
    expect(tabs()).toHaveLength(1)
  })
})

describe('switching sessions', () => {
  const TWO: ShellSnapshot = {
    workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
    activeWorkspaceId: 'w1',
    sessions: [
      {
        id: 's1',
        workspaceId: 'w1',
        createdAt: SHOWN,
        working: false,
        fresh: false,
        panel: { tabs: [PLAN], activeTabId: 'plan' }
      },
      {
        id: 's2',
        workspaceId: 'w1',
        createdAt: SHOWN,
        working: false,
        fresh: false,
        panel: { tabs: [BENCHMARK], activeTabId: 'benchmark' }
      }
    ],
    activeSessionId: 's1'
  }

  const rows = (): HTMLElement[] => screen.getAllByRole('button', { name: /^Session · / })

  it('swaps the panel to the session the user switched to', async () => {
    await shellWith(TWO)
    expect(tabs().map((tab) => tab.textContent)).toEqual(['mdthe plan×'])

    await act(async () => {
      fireEvent.click(rows()[1])
    })

    expect(tabs().map((tab) => tab.textContent)).toEqual(['htmlbenchmark×'])
  })

  it('remembers each session\u2019s collapse, and shows a background show only on the switch', async () => {
    const port = await shellWith(TWO)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Collapse context panel' }))
    })

    // A show in the background session touches nothing on screen.
    await act(async () => {
      port.showTab('s2', PLAN)
    })
    expect(region()).toBeNull()
    expect(edge()).toHaveTextContent('1')

    await act(async () => {
      fireEvent.click(rows()[1])
    })
    // The other session's panel is open, and holds what was shown into it.
    expect(tabs().map((tab) => tab.textContent)).toEqual(['htmlbenchmark×', 'mdthe plan×'])

    await act(async () => {
      fireEvent.click(rows()[0])
    })
    // Back to the one the user collapsed, still collapsed.
    expect(region()).toBeNull()
    expect(edge()).not.toBeNull()
  })
})
