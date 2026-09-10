// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { PanelTab, SessionState, ShellSnapshot } from '../../shared/agent/port'
import { Shell } from './Shell'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import {
  createScriptedExhibitKeys,
  type ScriptedExhibitKeys
} from './testing/scripted-exhibit-keys'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedWorkflowRuns } from './testing/scripted-workflow-runs'
import { createScriptedWorkspace, type ScriptedWorkspace } from './testing/scripted-workspace'
import { sessionRows, sessionsShown } from './testing/sidebar'
import { settled } from './testing/settled'

const SHOWN = '2026-09-09T09:00:00.000Z'

const PLAN: PanelTab = {
  id: 'plan',
  title: 'the plan',
  kind: 'markdown',
  shownAt: SHOWN,
  path: '/repos/crucible/docs/plan.md'
}
const MOCK: PanelTab = {
  id: 'mock',
  title: 'the mock',
  kind: 'html',
  shownAt: SHOWN,
  path: '/repos/crucible/.crucible/align/mock.html'
}
const DEV_SERVER: PanelTab = {
  id: 'localhost',
  title: 'dev server',
  kind: 'url',
  shownAt: SHOWN,
  address: 'http://localhost:5241/extras'
}

function withTabs(tabs: readonly PanelTab[], activeTabId: string): Partial<ShellSnapshot> {
  return oneSession({ panel: { tabs, activeTabId } })
}

interface Driven {
  readonly port: ScriptedPort
  readonly workspace: ScriptedWorkspace
  readonly keys: ScriptedExhibitKeys
}

async function shellWith(
  snapshot: Partial<ShellSnapshot>,
  options: { readonly runs?: boolean } = {}
): Promise<Driven> {
  const port = createScriptedPort(snapshot)
  port.models = [{ id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off', 'low'] }]
  port.exhibits.set('plan', '# The plan\n\nOne paragraph of it.')
  const workspace = createScriptedWorkspace()
  const keys = createScriptedExhibitKeys()
  render(
    <Shell
      port={port}
      workspace={workspace}
      commands={createScriptedCommands()}
      exhibitKeys={keys}
      {...(options.runs === true ? { workflowRuns: createScriptedWorkflowRuns([]) } : {})}
    />
  )
  await sessionsShown()
  await settled()
  return { port, workspace, keys }
}

const panel = (): HTMLElement | null => screen.queryByLabelText('Context panel')
const edge = (): HTMLElement | null => screen.queryByRole('button', { name: 'Open context panel' })
const chat = (): HTMLElement | null => document.querySelector('.main')
const frame = (): HTMLElement | null => document.querySelector('.exhibit webview')
const tabs = (): HTMLElement[] => screen.queryAllByRole('tab')
const ops = (port: ScriptedPort): string[] => port.calls.map((call) => call.op)

function place(): 'none' | 'collapsed' | 'split' | 'maximized' {
  if (edge() !== null) return 'collapsed'
  const shown = panel()
  if (shown === null) return 'none'
  return shown.classList.contains('max') ? 'maximized' : 'split'
}

const maximizeControl = (): HTMLElement | null =>
  screen.queryByRole('button', { name: 'Maximize context panel' })
const exitControl = (): HTMLElement | null =>
  screen.queryByRole('button', { name: 'Exit maximize' })

async function click(control: HTMLElement | null): Promise<void> {
  if (control === null) throw new Error('there is no such control on screen')
  await act(async () => {
    fireEvent.click(control)
  })
}

async function maximize(): Promise<void> {
  await click(maximizeControl())
}

async function escape(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(document, { key: 'Escape' })
  })
}

async function guestEscape(keys: ScriptedExhibitKeys): Promise<void> {
  await act(async () => {
    keys.pressEscape()
  })
}

const box = (): HTMLElement => screen.getByLabelText('Message')

const TREE = {
  roots: [
    {
      ref: 'n1',
      text: 'Scaffold the panel.',
      at: SHOWN,
      children: [{ ref: 'n2', text: 'Wire the strip up.', at: SHOWN, children: [] }]
    }
  ],
  path: ['n1', 'n2']
}

async function type(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(box(), { target: { value: text, selectionStart: text.length } })
  })
}

async function enter(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(box(), { key: 'Enter' })
  })
  await settled()
}

async function send(text: string): Promise<void> {
  await type(text)
  await enter()
}

async function paste(name: string): Promise<void> {
  await act(async () => {
    fireEvent(
      document,
      Object.assign(new Event('paste', { bubbles: true, cancelable: true }), {
        clipboardData: {
          items: [
            {
              kind: 'file',
              type: 'image/png',
              getAsFile: () => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
            }
          ]
        }
      })
    )
  })
  // The bytes are read through promises this test does not own.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function runBash(command: string, workspace: ScriptedWorkspace): Promise<void> {
  await send(`!${command}`)
  const runId = workspace.started.at(-1)?.runId
  if (runId === undefined) throw new Error('no bash run was started')
  await act(async () => {
    workspace.output(runId, `${command} said something\n`)
  })
}

describe('the control', () => {
  it('sits in the strip\u2019s tools, before the collapse control', async () => {
    await shellWith(withTabs([PLAN], 'plan'))

    const tools = document.querySelector('.ctx .strip-tools')
    expect(tools).not.toBeNull()
    expect(
      [...(tools?.querySelectorAll('button') ?? [])].map((found) => found.getAttribute('aria-label'))
    ).toEqual(['Maximize context panel', 'Collapse context panel'])
  })

  it('maximizes on a click and returns the split on the next', async () => {
    await shellWith(withTabs([PLAN], 'plan'))
    expect(place()).toBe('split')

    await maximize()
    expect(place()).toBe('maximized')

    await click(exitControl())
    expect(place()).toBe('split')
  })

  it('renames itself for the way it goes, keeping the same glyph', async () => {
    await shellWith(withTabs([PLAN], 'plan'))
    expect(maximizeControl()?.textContent).toBe('\u2922')
    expect(maximizeControl()).not.toHaveClass('on')
    expect(exitControl()).toBeNull()

    await maximize()

    expect(maximizeControl()).toBeNull()
    expect(exitControl()?.textContent).toBe('\u2922')
    expect(exitControl()).toHaveClass('stool', 'on')
  })

  it('is a real button, operable from the keyboard like the strip\u2019s others', async () => {
    await shellWith(withTabs([PLAN], 'plan'))

    const control = maximizeControl() as HTMLElement
    expect(control.tagName).toBe('BUTTON')
    expect(control).not.toBeDisabled()
    expect(control).not.toHaveAttribute('tabindex')
    control.focus()
    expect(document.activeElement).toBe(control)
  })

  it('is nowhere else in the window, and nowhere at all on a collapsed panel', async () => {
    await shellWith(withTabs([PLAN, MOCK], 'plan'))

    expect(screen.getAllByRole('button', { name: /aximize/ })).toHaveLength(1)
    expect(document.querySelector('.ctx .where')?.textContent).not.toContain('\u2922')
    expect(document.querySelector('.main > .top')?.textContent).not.toContain('\u2922')

    await click(screen.getByRole('button', { name: 'Collapse context panel' }))

    expect(place()).toBe('collapsed')
    expect(maximizeControl()).toBeNull()
    expect(exitControl()).toBeNull()
    expect(screen.getByRole('button', { name: 'Open context panel' }).textContent).not.toContain(
      '\u2922'
    )
  })

  it('crosses nothing to the agent: no port call, no event', async () => {
    const { port } = await shellWith(withTabs([PLAN], 'plan'))
    await settled()
    const before = [...port.calls]
    const said: string[] = []
    port.onEvent((event) => said.push(event.type))

    await maximize()
    await click(exitControl())

    expect(port.calls).toEqual(before)
    expect(said).toEqual([])
  })
})

describe('what maximized looks like', () => {
  it('takes the whole body row: no width of its own, and no divider', async () => {
    await shellWith(withTabs([PLAN], 'plan'))
    const body = document.querySelector('.body')
    expect(screen.getByLabelText('Resize context panel')).toBeInTheDocument()

    await maximize()

    const shown = panel() as HTMLElement
    expect(shown.parentElement).toBe(body)
    expect(shown).toHaveClass('ctx', 'max')
    expect(shown.style.width).toBe('')
    expect(screen.queryByLabelText('Resize context panel')).toBeNull()
    expect(chat()).not.toBeVisible()
  })

  it('keeps the strip, the address row and the exhibit, in that order', async () => {
    await shellWith(withTabs([PLAN, MOCK, DEV_SERVER], 'plan'))
    const before = [...(panel()?.children ?? [])].map((child) => child.className)

    await maximize()

    expect([...(panel()?.children ?? [])].map((child) => child.className)).toEqual(before)
    expect(before).toEqual(['tabstrip', 'where', 'exhibit'])
  })

  it('keeps every tab, its badge, the active accent and the close \u00d7', async () => {
    await shellWith(withTabs([PLAN, MOCK, DEV_SERVER], 'mock'))

    await maximize()

    expect(tabs().map((tab) => tab.textContent)).toEqual([
      'mdthe plan\u00d7',
      'htmlthe mock\u00d7',
      'webdev server\u00d7'
    ])
    expect(tabs()[1]).toHaveClass('active')
    expect(tabs()[1]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Close the mock' })).toBeInTheDocument()
    expect(document.querySelector('.ctx .strip-tools')).not.toBeNull()
  })

  it('changes nothing about the panel\u2019s own chrome but the class that widens it', async () => {
    await shellWith(withTabs([PLAN], 'plan'))
    // Everything but the tools, whose on-state is the control saying which way
    // it goes from here.
    const chrome = (): string[] =>
      [...(panel()?.querySelectorAll('*') ?? [])]
        .filter((node) => node.closest('.strip-tools') === null)
        .map((node) => node.className.toString())
    const before = chrome()

    await maximize()

    expect(chrome()).toEqual(before)
  })

  it('shows nothing of the session\u2019s top bar', async () => {
    await shellWith(
      oneSession({
        panel: { tabs: [PLAN], activeTabId: 'plan' },
        usage: { usedTokens: 1200, contextWindow: 200000, cost: 0.42 },
        cacheMisses: { count: 2, dollars: 0.11 }
      })
    )
    expect(screen.getByRole('button', { name: 'Session menu' })).toBeInTheDocument()

    await maximize()

    expect(document.querySelector('.main > .top')).not.toBeVisible()
    expect(screen.queryByRole('button', { name: 'Session menu' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Session cost' })).toBeNull()
    expect(screen.queryByLabelText('Context usage')).not.toBeVisible()
    expect(panel()?.querySelector('.top')).toBeNull()
    expect(panel()?.textContent).not.toContain('ctx')
  })

  it('shows nothing of the chat column, and leaves nothing in it to focus', async () => {
    const { workspace } = await shellWith(withTabs([PLAN], 'plan'))
    await runBash('echo hello', workspace)
    await send('a message in the transcript')

    await maximize()

    expect(chat()).not.toBeVisible()
    expect(screen.queryByRole('log')).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    expect(document.querySelector('.drawer')).not.toBeVisible()
    expect(document.querySelector('.chat')).not.toBeVisible()
    const focusable = [...(chat()?.querySelectorAll('button, textarea, [tabindex], a') ?? [])]
    expect(focusable.length).toBeGreaterThan(0)
    for (const node of focusable) expect(node).not.toBeVisible()
  })

  it('leaves the sidebar untouched, and every door in it open', async () => {
    const { port } = await shellWith({
      workspaces: [
        { id: 'w1', name: 'crucible', path: '/repos/crucible' },
        { id: 'w2', name: 'pi-extensions', path: '/repos/pi-extensions' }
      ],
      activeWorkspaceId: 'w1',
      activeSessionId: 's1',
      sessions: [
        {
          id: 's1',
          workspaceId: 'w1',
          createdAt: SHOWN,
          title: 'the maximized one',
          working: false,
          fresh: false,
          panel: { tabs: [PLAN], activeTabId: 'plan' }
        },
        {
          id: 's2',
          workspaceId: 'w1',
          createdAt: SHOWN,
          title: 'the other one',
          working: false,
          fresh: false
        }
      ]
    })
    const sidebar = screen.getByLabelText('Workspaces and sessions')
    const before = sidebar.textContent

    await maximize()

    expect(sidebar.textContent).toBe(before)
    expect(sidebar).toBeVisible()
    expect(sessionRows()).toHaveLength(2)
    expect(within(sidebar).getByRole('button', { name: 'Settings' })).toBeVisible()

    await click(within(sidebar).getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
    await escape()

    await click(sessionRows()[1])
    expect(ops(port)).toContain('activateSession')
    expect(place()).toBe('none')

    await click(within(sidebar).getByRole('button', { name: 'pi-extensions' }))
    expect(ops(port)).toContain('activateWorkspace')
  })
})

describe('the exhibit across the change', () => {
  it('keeps the very same guest, never remounting it', async () => {
    const { port } = await shellWith(withTabs([MOCK], 'mock'))
    const guest = frame()
    expect(guest).not.toBeNull()

    await maximize()
    expect(frame()).toBe(guest)

    await click(exitControl())

    expect(frame()).toBe(guest)
    expect(frame()?.getAttribute('src')).toBe('file:///repos/crucible/.crucible/align/mock.html')
    expect(ops(port)).not.toContain('exhibit')
  })

  it('re-reads no markdown body on the way in or out', async () => {
    const { port } = await shellWith(withTabs([PLAN], 'plan'))
    const reads = (): number => ops(port).filter((op) => op === 'exhibit').length
    expect(reads()).toBe(1)

    await maximize()
    await settled()
    await click(exitControl())
    await settled()

    expect(reads()).toBe(1)
    expect(document.querySelector('.exhibit .markdown')).toHaveTextContent('One paragraph of it.')
  })

  it('keeps showing where a web guest navigated to, and says so', async () => {
    await shellWith(withTabs([DEV_SERVER], 'localhost'))
    const guest = frame() as HTMLElement
    await act(async () => {
      guest.dispatchEvent(
        Object.assign(new Event('did-navigate'), { url: 'http://localhost:5241/extras/confirm' })
      )
    })

    await maximize()
    expect(frame()).toBe(guest)
    expect(screen.getByRole('button', { name: 'Copy location' })).toHaveTextContent(
      'http://localhost:5241/extras/confirm'
    )

    await click(exitControl())

    expect(frame()).toBe(guest)
    expect(screen.getByRole('button', { name: 'Copy location' })).toHaveTextContent(
      'http://localhost:5241/extras/confirm'
    )
  })

  it('activates and closes tabs exactly as the split does', async () => {
    const { port } = await shellWith(withTabs([PLAN, MOCK], 'plan'))
    await maximize()

    await click(tabs()[1])
    expect(port.calls).toContainEqual({ op: 'activateTab', args: ['s1', 'mock'] })
    expect(tabs()[1]).toHaveAttribute('aria-selected', 'true')

    await click(screen.getByRole('button', { name: 'Close the mock' }))

    expect(port.calls).toContainEqual({ op: 'closeTab', args: ['s1', 'mock'] })
    expect(tabs()).toHaveLength(1)
    expect(place()).toBe('maximized')
  })
})

describe('leaving maximize', () => {
  it('comes back to the width the divider was left at, and never changes it', async () => {
    await shellWith(withTabs([PLAN], 'plan'))
    const line = screen.getByLabelText('Resize context panel')
    const row = line.parentElement as HTMLElement
    const column = line.previousElementSibling as HTMLElement
    const rect = (left: number, width: number): DOMRect =>
      ({ left, width, right: left + width, top: 0, bottom: 0, height: 0, x: left, y: 0,
        toJSON: () => ({}) }) as DOMRect
    row.getBoundingClientRect = () => rect(0, 1600)
    column.getBoundingClientRect = () => rect(248, 1027)
    line.getBoundingClientRect = () => rect(1275, 5)

    fireEvent.mouseDown(line)
    await act(async () => {
      fireEvent.mouseMove(window, { clientX: 900 })
    })
    await act(async () => {
      fireEvent.mouseUp(window)
    })
    expect(panel()?.style.width).toBe('700px')

    await maximize()
    expect(panel()?.style.width).toBe('')
    await click(exitControl())

    expect(panel()?.style.width).toBe('700px')
  })

  it('keeps the default width the default', async () => {
    await shellWith(withTabs([PLAN], 'plan'))
    expect(panel()?.style.width).toBe('44%')

    await maximize()
    await click(exitControl())

    expect(panel()?.style.width).toBe('44%')
  })

  it('collapses to the edge strip on \u21e5, and reopens into the split', async () => {
    await shellWith(withTabs([PLAN, MOCK], 'plan'))
    await maximize()

    await click(screen.getByRole('button', { name: 'Collapse context panel' }))

    expect(place()).toBe('collapsed')
    expect(edge()).toHaveTextContent('2')
    expect(chat()).toBeVisible()
    expect(screen.getByRole('button', { name: 'Session menu' })).toBeVisible()

    await click(edge())

    expect(place()).toBe('split')
    expect(exitControl()).toBeNull()
  })

  it('loses nothing of the session on the way round', async () => {
    const { port, workspace } = await shellWith(withTabs([PLAN], 'plan'))
    await runBash('echo hello', workspace)
    await send('what the transcript held')
    expect(port.snapshotNow.sessions[0]?.working).toBe(true)
    await send('the queued one')
    await paste('shot.png')
    await type('a draft nobody sent')

    await maximize()
    await click(exitControl())

    expect(screen.getByRole('log')).toHaveTextContent('what the transcript held')
    expect(box()).toHaveValue('a draft nobody sent')
    expect(
      [...document.querySelectorAll('.imgchip img')].map((chip) => chip.getAttribute('alt'))
    ).toEqual(['shot.png'])
    expect(screen.getByLabelText('Queued messages')).toHaveTextContent('the queued one')
    expect(document.querySelector('.drawerout')).toHaveTextContent('echo hello said something')
    expect(port.snapshotNow.sessions[0]?.working).toBe(true)
    expect(ops(port)).not.toContain('cancel')
  })

  it('leaves the reader exactly where they were in the chat', async () => {
    const { port } = await shellWith(withTabs([PLAN], 'plan'))
    await send('run the tests')
    await act(async () => {
      port.toolStarted('s1', 'c1', 'bash', 'npm test')
      port.toolEnded('s1', 'c1', true, 'ran 1 test')
      port.endTurn('s1')
    })
    await settled()
    const chain = screen.getByRole('button', { name: /Tool chain/ })
    await click(chain)
    expect(chain).toHaveAttribute('aria-expanded', 'true')
    await type('half a sentence')
    const composer = box() as HTMLTextAreaElement
    composer.setSelectionRange(4, 4)
    const transcript = document.querySelector('.chat')

    await maximize()
    await click(exitControl())

    // The same nodes, not rebuilt ones: what the reader left is still in them.
    expect(document.querySelector('.chat')).toBe(transcript)
    expect(screen.getByRole('button', { name: /Tool chain/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByRole('button', { name: 'bash npm test' })).toBeInTheDocument()
    expect(box()).toBe(composer)
    expect(composer.selectionStart).toBe(4)
    expect(composer.selectionEnd).toBe(4)
  })
})

describe('escape', () => {
  it('un-maximizes, and does nothing else at all', async () => {
    const { port } = await shellWith(withTabs([PLAN], 'plan'))
    await maximize()

    await escape()

    expect(place()).toBe('split')
    expect(chat()).toBeVisible()
    expect(screen.getByRole('button', { name: 'Session menu' })).toBeVisible()
    expect(ops(port)).not.toContain('cancel')
  })

  it('closes an overlay first, and the panel only once the region is empty', async () => {
    await shellWith(withTabs([PLAN], 'plan'), { runs: true })
    await maximize()

    await act(async () => {
      fireEvent.keyDown(document, { key: 'r', metaKey: true })
    })
    await settled()
    expect(screen.getByLabelText('All runs')).toBeInTheDocument()
    expect(place()).toBe('maximized')

    await escape()
    expect(screen.queryByLabelText('All runs')).toBeNull()
    expect(place()).toBe('maximized')

    await escape()
    expect(place()).toBe('split')
  })

  it('takes the panel off before it stops a working turn', async () => {
    const { port } = await shellWith(
      oneSession({ working: true, panel: { tabs: [PLAN], activeTabId: 'plan' } })
    )
    await maximize()

    await escape()

    expect(place()).toBe('split')
    expect(ops(port)).not.toContain('cancel')
    expect(port.snapshotNow.sessions[0]?.working).toBe(true)

    await escape()

    expect(ops(port)).toContain('cancel')
  })

  it('never opens the session tree, however fast the two presses are', async () => {
    await shellWith(withTabs([PLAN], 'plan'))
    await maximize()

    await escape()
    await escape()

    expect(place()).toBe('split')
    expect(screen.queryByLabelText('Session tree')).toBeNull()
  })

  it('still stops a working turn while the panel is split', async () => {
    const { port } = await shellWith(
      oneSession({ working: true, panel: { tabs: [PLAN], activeTabId: 'plan' } })
    )

    await escape()

    expect(ops(port)).toContain('cancel')
    expect(place()).toBe('split')
  })

  it('still opens the session tree on a double press, panel or no panel', async () => {
    const { port } = await shellWith(withTabs([PLAN], 'plan'))
    port.trees.set('s1', TREE)

    await click(screen.getByRole('button', { name: 'Collapse context panel' }))
    await escape()
    await escape()
    await settled()

    expect(screen.getByLabelText('Session tree')).toBeInTheDocument()
    expect(place()).toBe('collapsed')
  })
})

describe('a summarize that is still running', () => {
  it('is not cancelled by the Escape that takes the panel off', async () => {
    const { port } = await shellWith(withTabs([PLAN], 'plan'))
    port.trees.set('s1', TREE)
    port.holdJump = true
    // The tree is the only door to a summarize, and it opens from the split.
    await escape()
    await escape()
    await click(screen.getByText('Scaffold the panel.'))
    await click(screen.getByRole('button', { name: /Continue with summary/ }))
    expect(ops(port)).toContain('jump')
    // The tree is closed by hand rather than by Escape, which would stop the
    // summarize: what is under test is the press after it.
    await click(screen.getByText('esc close'))
    expect(document.querySelector('.region')).toBeNull()

    await maximize()
    await escape()

    expect(place()).toBe('split')
    expect(ops(port)).not.toContain('cancel')

    await escape()

    expect(ops(port)).toContain('cancel')
  })
})

describe('gestures that change nothing', () => {
  it('ignores a double click on the divider, the strip, a tab and the exhibit', async () => {
    await shellWith(withTabs([PLAN, MOCK], 'plan'))

    for (const target of [
      screen.getByLabelText('Resize context panel'),
      document.querySelector('.tabstrip') as HTMLElement,
      tabs()[0],
      document.querySelector('.exhibit') as HTMLElement
    ]) {
      await act(async () => {
        fireEvent.doubleClick(target)
      })
      expect(place()).toBe('split')
    }

    await maximize()
    for (const target of [
      document.querySelector('.tabstrip') as HTMLElement,
      tabs()[0],
      document.querySelector('.exhibit') as HTMLElement
    ]) {
      await act(async () => {
        fireEvent.doubleClick(target)
      })
      expect(place()).toBe('maximized')
    }
  })

  it('claims no chord: nothing but Escape and the control moves the panel', async () => {
    await shellWith(withTabs([PLAN], 'plan'), { runs: true })
    const chords = [
      { key: 'm' },
      { key: 'M', metaKey: true },
      { key: 'f', metaKey: true },
      { key: 'Enter' },
      { key: 'Tab' },
      { key: ',', metaKey: true },
      { key: 'r', metaKey: true }
    ]

    for (const chord of chords) {
      await act(async () => {
        fireEvent.keyDown(document, chord)
      })
      expect(place()).toBe('split')
    }
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })

    await maximize()
    for (const chord of chords) {
      await act(async () => {
        fireEvent.keyDown(document, chord)
      })
      expect(place()).toBe('maximized')
    }

    await escape()
    if (place() === 'maximized') await escape()
    expect(place()).toBe('split')
  })
})

describe('an Escape out of a shown page', () => {
  it('leaves a maximized panel from wherever the focus is', async () => {
    const { keys } = await shellWith(withTabs([MOCK], 'mock'))
    await maximize()

    await guestEscape(keys)

    expect(place()).toBe('split')
    expect(chat()).toBeVisible()
  })

  it('does nothing while the panel is not maximized', async () => {
    const { port, keys } = await shellWith(
      oneSession({ working: true, panel: { tabs: [MOCK], activeTabId: 'mock' } }),
      { runs: true }
    )

    await guestEscape(keys)
    expect(place()).toBe('split')
    expect(ops(port)).not.toContain('cancel')

    await act(async () => {
      fireEvent.keyDown(document, { key: 'r', metaKey: true })
    })
    await settled()
    await guestEscape(keys)
    expect(screen.getByLabelText('All runs')).toBeInTheDocument()

    await guestEscape(keys)
    await guestEscape(keys)
    expect(screen.queryByLabelText('Session tree')).toBeNull()
    expect(ops(port)).not.toContain('cancel')
  })

  it('closes no overlay that is up over the maximized panel', async () => {
    const { keys } = await shellWith(withTabs([MOCK], 'mock'), { runs: true })
    await maximize()
    await act(async () => {
      fireEvent.keyDown(document, { key: 'r', metaKey: true })
    })
    await settled()

    await guestEscape(keys)

    expect(screen.getByLabelText('All runs')).toBeInTheDocument()
    expect(place()).toBe('maximized')
  })

  it('works with no such seam at all, minus that one way out', async () => {
    const port = createScriptedPort(withTabs([MOCK], 'mock'))
    port.models = []
    render(
      <Shell port={port} workspace={createScriptedWorkspace()} commands={createScriptedCommands()} />
    )
    await sessionsShown()
    await settled()

    await maximize()
    expect(place()).toBe('maximized')
    await escape()
    expect(place()).toBe('split')
  })
})

describe('per session, and for this launch only', () => {
  const THREE: ShellSnapshot = {
    workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
    activeWorkspaceId: 'w1',
    activeSessionId: 's1',
    sessions: ['s1', 's2', 's3'].map((id) => ({
      id,
      workspaceId: 'w1',
      createdAt: SHOWN,
      title: `session ${id}`,
      working: false,
      fresh: false,
      panel: { tabs: [PLAN], activeTabId: 'plan' }
    }))
  }

  it('brings each session back the way it was left', async () => {
    await shellWith(THREE)

    await maximize()
    await click(sessionRows()[1])
    await click(screen.getByRole('button', { name: 'Collapse context panel' }))
    await click(sessionRows()[2])
    expect(place()).toBe('split')

    await click(sessionRows()[0])
    expect(place()).toBe('maximized')

    await click(sessionRows()[1])
    expect(place()).toBe('collapsed')

    await click(sessionRows()[2])
    expect(place()).toBe('split')
  })

  it('holds it across a workspace switch and across an overlay', async () => {
    const { port } = await shellWith(
      {
        workspaces: [
          { id: 'w1', name: 'crucible', path: '/repos/crucible' },
          { id: 'w2', name: 'pi-extensions', path: '/repos/pi-extensions' }
        ],
        activeWorkspaceId: 'w1',
        activeSessionId: 's1',
        sessions: [
          {
            id: 's1',
            workspaceId: 'w1',
            createdAt: SHOWN,
            title: 'the maximized one',
            working: false,
            fresh: false,
            panel: { tabs: [PLAN], activeTabId: 'plan' }
          },
          {
            id: 's2',
            workspaceId: 'w2',
            createdAt: SHOWN,
            title: 'over the other side',
            working: false,
            fresh: false
          }
        ]
      },
      { runs: true }
    )
    await maximize()

    const sidebar = screen.getByLabelText('Workspaces and sessions')
    await click(within(sidebar).getByRole('button', { name: 'pi-extensions' }))
    expect(place()).toBe('none')
    await click(within(sidebar).getByRole('button', { name: 'crucible' }))
    await settled()
    expect(port.snapshotNow.activeSessionId).toBe('s1')
    expect(place()).toBe('maximized')

    await act(async () => {
      fireEvent.keyDown(document, { key: 'r', metaKey: true })
    })
    await settled()
    await escape()

    expect(place()).toBe('maximized')
  })

  it('forgets a session\u2019s maximize when the session goes', async () => {
    const { port } = await shellWith(THREE)
    await maximize()

    await act(async () => {
      port.update((snapshot) => ({
        ...snapshot,
        sessions: snapshot.sessions.filter((session) => session.id !== 's1'),
        activeSessionId: 's2'
      }))
    })
    expect(place()).toBe('split')

    await act(async () => {
      port.update((snapshot) => ({ ...snapshot, activeSessionId: 's1' }))
    })
    expect(place()).toBe('none')
  })

  it('starts a fresh launch with no session maximized', async () => {
    const { port } = await shellWith(THREE)
    await maximize()
    expect(place()).toBe('maximized')

    const again = render(
      <Shell port={port} workspace={createScriptedWorkspace()} commands={createScriptedCommands()} />
    )
    await settled()

    expect(
      [...again.container.querySelectorAll('.ctx')].map((node) => node.className)
    ).toEqual(['ctx'])
  })
})

describe('an empty panel', () => {
  it('gives the chat back when the user closes the last tab', async () => {
    await shellWith(withTabs([PLAN], 'plan'))
    await maximize()

    await click(screen.getByRole('button', { name: 'Close the plan' }))

    expect(place()).toBe('none')
    expect(chat()).toBeVisible()
    expect(screen.getByRole('button', { name: 'Session menu' })).toBeVisible()
    expect(edge()).toBeNull()
  })

  it('gives it back when the agent closes it, and opens the next tab split', async () => {
    const { port } = await shellWith(withTabs([PLAN], 'plan'))
    await maximize()

    await act(async () => {
      port.update((snapshot) => ({
        ...snapshot,
        sessions: snapshot.sessions.map((session) => {
          const rest: SessionState = { ...session }
          delete (rest as { panel?: unknown }).panel
          return rest
        })
      }))
    })
    expect(place()).toBe('none')
    expect(chat()).toBeVisible()

    await act(async () => {
      port.showTab('s1', MOCK)
    })
    await settled()

    expect(place()).toBe('split')
  })

  it('lands the same way after a session reset', async () => {
    const { port } = await shellWith(withTabs([PLAN], 'plan'))
    await send('something to reset away')
    await maximize()

    await act(async () => {
      port.resetSession('s1')
    })
    await settled()

    expect(place()).toBe('none')
    expect(chat()).toBeVisible()

    await act(async () => {
      port.showTab('s1', MOCK)
    })
    await settled()

    expect(place()).toBe('split')
  })

  it('is untouched by a jump, which leaves the tabs alone', async () => {
    const { port } = await shellWith({
      workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
      activeWorkspaceId: 'w1',
      activeSessionId: 's1',
      sessions: [
        {
          id: 's1',
          workspaceId: 'w1',
          createdAt: SHOWN,
          title: 'the maximized one',
          working: false,
          fresh: false,
          panel: { tabs: [PLAN], activeTabId: 'plan' }
        },
        { id: 's2', workspaceId: 'w1', createdAt: SHOWN, title: 'the other', working: false, fresh: false }
      ]
    })
    port.trees.set('s2', {
      roots: [{ ref: 'n1', text: 'Scaffold the panel.', at: SHOWN, children: [] }],
      path: ['n1']
    })
    await maximize()

    // The jump happens in the other session, because the tree is reachable
    // only from a session whose panel is not maximized.
    await click(sessionRows()[1])
    await escape()
    await escape()
    await click(screen.getByText('Scaffold the panel.'))
    await click(screen.getByRole('button', { name: /Continue from here/ }))
    await settled()
    expect(ops(port)).toContain('jump')

    await click(sessionRows()[0])

    expect(place()).toBe('maximized')
    expect(tabs()).toHaveLength(1)
  })
})

describe('the agent side', () => {
  it('opens a shown tab in the maximized panel, in place', async () => {
    const { port } = await shellWith(withTabs([PLAN], 'plan'))
    await maximize()
    const strip = document.querySelector('.tabstrip')

    await act(async () => {
      port.showTab('s1', MOCK)
    })
    await settled()

    expect(place()).toBe('maximized')
    expect(chat()).not.toBeVisible()
    expect(document.querySelector('.tabstrip')).toBe(strip)
    expect(tabs()).toHaveLength(2)
    expect(tabs()[1]).toHaveAttribute('aria-selected', 'true')
    expect(frame()?.getAttribute('src')).toBe('file:///repos/crucible/.crucible/align/mock.html')
  })

  it('changes nothing on screen when the show lands in another session', async () => {
    const { port } = await shellWith({
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
          panel: { tabs: [PLAN], activeTabId: 'plan' }
        },
        { id: 's2', workspaceId: 'w1', createdAt: SHOWN, working: false, fresh: false }
      ]
    })
    await maximize()
    const before = panel()?.innerHTML

    await act(async () => {
      port.showTab('s2', MOCK)
    })
    await settled()

    expect(place()).toBe('maximized')
    expect(panel()?.innerHTML).toBe(before)
  })
})

describe('overlays over a maximized panel', () => {
  it('leave it exactly as it was, exhibit and all', async () => {
    await shellWith(withTabs([MOCK], 'mock'), { runs: true })
    await maximize()
    const guest = frame()

    await act(async () => {
      fireEvent.keyDown(document, { key: 'r', metaKey: true })
    })
    await settled()
    expect(place()).toBe('maximized')

    await act(async () => {
      fireEvent.keyDown(document, { key: 'r', metaKey: true })
    })
    await settled()

    expect(place()).toBe('maximized')
    expect(frame()).toBe(guest)
  })

  it('never cover the tab strip, so \u2922 stays live under one', async () => {
    await shellWith(withTabs([MOCK], 'mock'), { runs: true })
    await maximize()
    await act(async () => {
      fireEvent.keyDown(document, { key: 'r', metaKey: true })
    })
    await settled()

    const region = document.querySelector('.region')
    expect(region?.parentElement).toBe(document.querySelector('.body'))
    expect(region?.contains(panel())).toBe(false)

    await click(exitControl())

    expect(place()).toBe('split')
    expect(screen.getByLabelText('All runs')).toBeInTheDocument()
  })
})
