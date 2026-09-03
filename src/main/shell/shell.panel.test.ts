// @vitest-environment node
//
// Driven against the real panel model and a real store, with no Electron and
// no IPC, which is the point of having put the rules here.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import type { PortEvent, SessionId, ShellSnapshot } from '../../shared/agent/port'
import { createPanelModel, type PanelModel } from '../panel/model'
import { storePanelPersistence } from '../panel/store-persistence'
import { createShell, type Shell } from './shell'
import { createShellStore } from './store'

let workspace: string
let file: string
let panel: PanelModel
let shell: Shell
let events: PortEvent[]

/** Settles the microtasks a scripted turn is made of. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

function build(pauseMs = 0): void {
  const store = createShellStore(file)
  panel = createPanelModel({ persistence: storePanelPersistence(store) })
  shell = createShell({
    store,
    panel,
    adapter: createFakeAdapter({ pauseMs }),
    flavor: 'fake',
    pickFolder: async () => workspace
  })
  events = []
  shell.onEvent((event) => events.push(event))
}

async function withSession(): Promise<SessionId> {
  const workspaceId = await shell.addWorkspace()
  if (workspaceId === null) throw new Error('the picker was supposed to answer')
  return shell.createSession(workspaceId)
}

function exhibit(name: string, body = '# an exhibit'): string {
  const path = join(workspace, name)
  writeFileSync(path, body, 'utf8')
  return path
}

const types = (): string[] => events.map((event) => event.type)

const sessionOf = (snapshot: ShellSnapshot, id: SessionId) =>
  snapshot.sessions.find((session) => session.id === id)

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'crucible-shell-panel-'))
  file = join(workspace, 'state', 'shell-state.json')
  build()
})

afterEach(() => {
  shell.dispose()
  rmSync(workspace, { recursive: true, force: true })
})

describe('what a show puts on the port', () => {
  it('folds the tabs into the session and says the snapshot first', async () => {
    const sessionId = await withSession()
    const before = events.length
    const path = exhibit('plan.md')

    panel.show(sessionId, workspace, path, 'the plan')

    expect(types().slice(before)).toEqual(['state', 'panel_shown'])
    const said = events[before]
    // The snapshot the event names is already in the listener's hands.
    expect(said.type === 'state' && sessionOf(said.snapshot, sessionId)?.panel).toEqual({
      tabs: [
        { id: 'plan', title: 'the plan', kind: 'markdown', shownAt: expect.any(String), path }
      ],
      activeTabId: 'plan'
    })
    expect(events[before + 1]).toEqual({ type: 'panel_shown', sessionId, tabId: 'plan' })
  })

  it('leaves the panel absent for a session with no tabs', async () => {
    const sessionId = await withSession()

    expect(sessionOf(await shell.snapshot(), sessionId)?.panel).toBeUndefined()
  })

  it('announces a show in a background session without touching the active one', async () => {
    const first = await withSession()
    const second = await withSession()
    const before = events.length

    panel.show(first, workspace, exhibit('plan.md'), 'the plan')

    const snapshot = await shell.snapshot()
    expect(snapshot.activeSessionId).toBe(second)
    expect(sessionOf(snapshot, second)?.panel).toBeUndefined()
    expect(sessionOf(snapshot, first)?.panel?.tabs).toHaveLength(1)
    expect(events.slice(before).at(-1)).toEqual({
      type: 'panel_shown',
      sessionId: first,
      tabId: 'plan'
    })
  })
})

describe('where the session works', () => {
  it('names the worktree\u2019s own file, not the checkout\u2019s', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'crucible-shell-worktree-'))
    const checkoutSession = await withSession()
    const worktreeSession = await withSession()
    await shell.setWorktree(worktreeSession, { path: worktree })
    writeFileSync(join(worktree, 'plan.md'), '# the worktree plan', 'utf8')
    exhibit('plan.md', '# the checkout plan')

    const snapshot = await shell.snapshot()
    const worksIn = (id: SessionId): string =>
      sessionOf(snapshot, id)?.worktree?.path ?? workspace
    panel.show(checkoutSession, worksIn(checkoutSession), 'plan.md', 'plan')
    panel.show(worktreeSession, worksIn(worktreeSession), 'plan.md', 'plan')

    const after = await shell.snapshot()
    const pathOf = (id: SessionId): string | undefined => {
      const tab = sessionOf(after, id)?.panel?.tabs[0]
      return tab?.kind === 'markdown' ? tab.path : undefined
    }
    expect(pathOf(worktreeSession)).toBe(join(worktree, 'plan.md'))
    expect(pathOf(checkoutSession)).toBe(join(workspace, 'plan.md'))
    expect(pathOf(worktreeSession)).not.toBe(pathOf(checkoutSession))
    rmSync(worktree, { recursive: true, force: true })
  })
})

describe('what the user does to a tab', () => {
  it('switches and closes through the model, and re-snapshots each time', async () => {
    const sessionId = await withSession()
    panel.show(sessionId, workspace, exhibit('plan.md'), 'plan')
    panel.show(sessionId, workspace, exhibit('report.md'), 'report')
    const before = events.length

    await shell.activateTab(sessionId, 'plan')
    expect(sessionOf(await shell.snapshot(), sessionId)?.panel?.activeTabId).toBe('plan')

    await shell.closeTab(sessionId, 'report')
    const snapshot = await shell.snapshot()

    expect(snapshot.sessions[0].panel?.tabs.map((tab) => tab.id)).toEqual(['plan'])
    // Two changes, two snapshots, and nothing said to the agent about either.
    expect(types().slice(before)).toEqual(['state', 'state'])
  })

  it('does nothing for a tab or a session that is no longer there', async () => {
    const sessionId = await withSession()
    panel.show(sessionId, workspace, exhibit('plan.md'), 'plan')
    const before = events.length

    await shell.activateTab(sessionId, 'gone')
    await shell.closeTab(sessionId, 'gone')
    await shell.activateTab('no-such-session', 'plan')
    await shell.closeTab('no-such-session', 'plan')

    expect(types().slice(before)).toEqual([])
    expect(sessionOf(await shell.snapshot(), sessionId)?.panel?.tabs).toHaveLength(1)
  })

  it('takes the region away when the last tab closes', async () => {
    const sessionId = await withSession()
    panel.show(sessionId, workspace, exhibit('plan.md'), 'plan')

    await shell.closeTab(sessionId, 'plan')

    expect(sessionOf(await shell.snapshot(), sessionId)?.panel).toBeUndefined()
  })
})

describe('the exhibit body', () => {
  it('comes back as the file says it now', async () => {
    const sessionId = await withSession()
    const path = exhibit('plan.md', '# the plan')
    panel.show(sessionId, workspace, path, 'plan')

    expect(await shell.exhibit(sessionId, 'plan')).toEqual({ body: '# the plan' })

    writeFileSync(path, '# the accepted plan', 'utf8')
    expect(await shell.exhibit(sessionId, 'plan')).toEqual({ body: '# the accepted plan' })
  })

  it('refuses a read it cannot carry out, in one display-safe sentence', async () => {
    const sessionId = await withSession()
    const path = exhibit('plan.md')
    panel.show(sessionId, workspace, path, 'plan')
    rmSync(path)

    await expect(shell.exhibit(sessionId, 'plan')).rejects.toThrow(
      'That exhibit could not be read: plan.md'
    )
    await expect(shell.exhibit(sessionId, 'gone')).rejects.toThrow(
      'That tab is no longer in the context panel.'
    )
    // The tab stays: curation is the agent's, not a failed read's.
    expect(sessionOf(await shell.snapshot(), sessionId)?.panel?.tabs).toHaveLength(1)
  })
})

describe('the turn counter', () => {
  it('counts a prompt, and a queued message that became one', async () => {
    const sessionId = await withSession()
    panel.show(sessionId, workspace, exhibit('plan.md'), 'plan')
    expect(panel.list(sessionId)).toContain('(shown this turn)')

    await shell.prompt(sessionId, 'hello')
    await settled()
    expect(panel.list(sessionId)).toContain('(shown 1 turn ago)')

    // Nothing was running, so this steering message is sent as a prompt, and a
    // prompt is a user instruction whatever key sent it.
    await shell.steer(sessionId, 'and again')
    await settled()
    expect(panel.list(sessionId)).toContain('(shown 2 turns ago)')
  })

  it('counts nothing for a shared bash run', async () => {
    const sessionId = await withSession()
    panel.show(sessionId, workspace, exhibit('plan.md'), 'plan')

    await shell.shareBashRun(sessionId, { command: 'ls', output: 'plan.md\n', exitCode: 0 })
    await settled()

    expect(panel.list(sessionId)).toContain('(shown this turn)')
  })

  it('counts nothing for a message delivered into a live turn', async () => {
    // Paced, so the turn is genuinely still running when the message is
    // queued into it.
    shell.dispose()
    build(30)
    const sessionId = await withSession()
    panel.show(sessionId, workspace, exhibit('plan.md'), 'plan')

    await shell.prompt(sessionId, 'hello')
    await shell.steer(sessionId, 'while it works')
    expect(panel.list(sessionId)).toContain('(shown 1 turn ago)')

    await shell.cancel(sessionId)
    await settled()
    expect(panel.list(sessionId)).toContain('(shown 1 turn ago)')
  })
})

describe('the session lifecycle', () => {
  it('clears the panel when the session is reset', async () => {
    const sessionId = await withSession()
    panel.show(sessionId, workspace, exhibit('plan.md'), 'plan')

    await shell.resetSession(sessionId)

    expect(sessionOf(await shell.snapshot(), sessionId)?.panel).toBeUndefined()
    expect(panel.list(sessionId)).toBe('The context panel is empty.')
  })

  it('forgets the tabs with the session that held them', async () => {
    const sessionId = await withSession()
    panel.show(sessionId, workspace, exhibit('plan.md'), 'plan')

    await shell.removeSession(sessionId)

    expect((await shell.snapshot()).sessions).toEqual([])
    expect(JSON.parse(readFileSync(file, 'utf8')).sessions).toEqual([])
  })

  it('forgets the tabs of every session in a workspace it removes', async () => {
    const sessionId = await withSession()
    panel.show(sessionId, workspace, exhibit('plan.md'), 'plan')
    const snapshot = await shell.snapshot()

    await shell.removeWorkspace(snapshot.workspaces[0].id)

    expect((await shell.snapshot()).sessions).toEqual([])
    expect(JSON.parse(readFileSync(file, 'utf8')).sessions).toEqual([])
  })
})

describe('a relaunch', () => {
  it('restores the tabs, minus the ones whose files are gone', async () => {
    const sessionId = await withSession()
    const gone = exhibit('gone.md')
    panel.show(sessionId, workspace, exhibit('kept.md'), 'kept')
    panel.show(sessionId, workspace, gone, 'gone')
    rmSync(gone)

    // A second shell over the same store file is what a relaunch is.
    shell.dispose()
    build()

    const restored = sessionOf(await shell.snapshot(), sessionId)?.panel
    expect(restored?.tabs.map((tab) => tab.id)).toEqual(['kept'])
    expect(restored?.activeTabId).toBe('kept')
  })
})
