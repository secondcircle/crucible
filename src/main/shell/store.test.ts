// @vitest-environment node
//
// Read the way a relaunch reads it: write through one store, then build a
// second over the same file and ask that one.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createShellStore } from './store'

let directory: string
let file: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'crucible-store-'))
  file = join(directory, 'state', 'shell-state.json')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('what survives a relaunch', () => {
  it('remembers workspaces, sessions, activation and the last model', () => {
    const first = createShellStore(file)
    const workspace = first.addWorkspace('/repos/crucible')
    const other = first.addWorkspace('/repos/homelab')
    const session = first.addSession({
      workspaceId: workspace.id,
      createdAt: '2026-08-19T14:00:00.000Z',
      token: 'opaque-1',
      model: 'fake/deterministic',
      thinkingLevel: 'low'
    })
    first.activateWorkspace(workspace.id)
    first.setLastModel('fake/deterministic')

    const relaunched = createShellStore(file)

    expect(relaunched.state.workspaces).toEqual([
      { id: workspace.id, path: '/repos/crucible' },
      { id: other.id, path: '/repos/homelab' }
    ])
    expect(relaunched.state.sessions).toEqual([
      {
        id: session.id,
        workspaceId: workspace.id,
        createdAt: '2026-08-19T14:00:00.000Z',
        token: 'opaque-1',
        model: 'fake/deterministic',
        thinkingLevel: 'low'
      }
    ])
    expect(relaunched.state.activeWorkspaceId).toBe(workspace.id)
    expect(relaunched.activeSessionId()).toBe(session.id)
    expect(relaunched.state.lastModel).toBe('fake/deterministic')
  })

  it('writes a versioned file and nothing that names \u03c0 storage', () => {
    const store = createShellStore(file)
    const workspace = store.addWorkspace('/repos/crucible')
    store.addSession({ workspaceId: workspace.id, createdAt: 'now', token: 'opaque-1' })

    const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>

    expect(written.version).toBe(1)
    expect(JSON.stringify(written)).not.toContain('.jsonl')
    expect(JSON.stringify(written)).not.toContain('sessions/')
  })

  it('carries a session’s panel through, tabs and turn counter alike', () => {
    const first = createShellStore(file)
    const workspace = first.addWorkspace('/repos/crucible')
    const session = first.addSession({ workspaceId: workspace.id, createdAt: 'now' })
    first.updateSession(session.id, {
      panel: {
        tabs: [
          {
            id: 'plan',
            title: 'the plan',
            path: '/tmp/plan.md',
            kind: 'markdown',
            shownAt: '2026-08-19T14:14:00.000Z',
            shownTurn: 2
          }
        ],
        activeTabId: 'plan',
        turn: 3
      }
    })

    expect(createShellStore(file).session(session.id)?.panel).toEqual({
      tabs: [
        {
          id: 'plan',
          title: 'the plan',
          path: '/tmp/plan.md',
          kind: 'markdown',
          shownAt: '2026-08-19T14:14:00.000Z',
          shownTurn: 2
        }
      ],
      activeTabId: 'plan',
      turn: 3
    })
  })

  it('carries a token’s flavor through beside the token itself', () => {
    const first = createShellStore(file)
    const workspace = first.addWorkspace('/repos/crucible')
    const session = first.addSession({
      workspaceId: workspace.id,
      createdAt: 'now',
      token: 'opaque-1',
      tokenFlavor: 'sdk'
    })

    expect(createShellStore(file).session(session.id)).toEqual({
      id: session.id,
      workspaceId: workspace.id,
      createdAt: 'now',
      token: 'opaque-1',
      tokenFlavor: 'sdk'
    })
  })

  it('carries a session’s title, last activity and titling spend through', () => {
    const first = createShellStore(file)
    const workspace = first.addWorkspace('/repos/crucible')
    const session = first.addSession({
      workspaceId: workspace.id,
      createdAt: 'now',
      title: 'Removing the composer hint bar',
      lastActivityAt: 'later',
      titlingSpend: 0.02
    })

    expect(createShellStore(file).session(session.id)).toEqual({
      id: session.id,
      workspaceId: workspace.id,
      createdAt: 'now',
      title: 'Removing the composer hint bar',
      lastActivityAt: 'later',
      titlingSpend: 0.02
    })
  })

  // A store written before sessions had titles loads exactly as it did, and
  // the session simply has none.
  it('loads a session with no title, activity or spend of its own', () => {
    const written = join(directory, 'shell-state.json')
    writeFileSync(
      written,
      JSON.stringify({
        version: 1,
        workspaces: [{ id: 'w', path: '/repos/crucible' }],
        sessions: [
          { id: 'older', workspaceId: 'w', createdAt: 'now' },
          { id: 'nonsense', workspaceId: 'w', createdAt: 'now', title: 7, titlingSpend: 'lots' }
        ],
        activeSessionByWorkspace: {}
      })
    )

    const store = createShellStore(written)

    expect(store.session('older')).toEqual({ id: 'older', workspaceId: 'w', createdAt: 'now' })
    expect(store.session('nonsense')?.title).toBeUndefined()
    expect(store.session('nonsense')?.titlingSpend).toBeUndefined()
  })

  // Absent reads as not restorable, which is the safe way to load a stamp this
  // build cannot vouch for.
  it('loads a flavor that is not a launch flavor, or has no token, as absent', () => {
    const written = join(directory, 'shell-state.json')
    writeFileSync(
      written,
      JSON.stringify({
        version: 1,
        workspaces: [{ id: 'w', path: '/repos/crucible' }],
        sessions: [
          { id: 'misspelled', workspaceId: 'w', createdAt: 'now', token: 't', tokenFlavor: 'SDK' },
          { id: 'stamp-only', workspaceId: 'w', createdAt: 'now', tokenFlavor: 'fake' },
          { id: 'intact', workspaceId: 'w', createdAt: 'now', token: 't', tokenFlavor: 'fake' }
        ],
        activeSessionByWorkspace: {}
      })
    )

    const store = createShellStore(written)

    expect(store.session('misspelled')?.tokenFlavor).toBeUndefined()
    expect(store.session('misspelled')?.token).toBe('t')
    expect(store.session('stamp-only')?.tokenFlavor).toBeUndefined()
    expect(store.session('intact')?.tokenFlavor).toBe('fake')
  })

  it('carries a session’s worktree and its fresh mark through', () => {
    const first = createShellStore(file)
    const workspace = first.addWorkspace('/repos/crucible')
    const session = first.addSession({
      workspaceId: workspace.id,
      createdAt: 'now',
      fresh: true
    })
    first.updateSession(session.id, {
      worktree: { path: '/repos/crucible/.crucible/worktrees/9f3a2c', branch: 'crucible/9f3a2c' }
    })

    expect(createShellStore(file).session(session.id)).toEqual({
      id: session.id,
      workspaceId: workspace.id,
      createdAt: 'now',
      fresh: true,
      worktree: { path: '/repos/crucible/.crucible/worktrees/9f3a2c', branch: 'crucible/9f3a2c' }
    })
  })

  it('takes the worktree off again when a session goes back to its checkout', () => {
    const first = createShellStore(file)
    const workspace = first.addWorkspace('/repos/crucible')
    const session = first.addSession({
      workspaceId: workspace.id,
      createdAt: 'now',
      fresh: true,
      worktree: { path: '/repos/crucible/.crucible/worktrees/9f3a2c' }
    })

    first.updateSession(session.id, { worktree: undefined })

    expect(first.session(session.id)?.worktree).toBeUndefined()
    expect(createShellStore(file).session(session.id)?.worktree).toBeUndefined()
    expect(readFileSync(file, 'utf8')).not.toContain('worktrees/9f3a2c')
  })

  // A record written before the mark existed is a session with a conversation,
  // and unlocking it would let a flip abandon one.
  it('loads a session with no fresh mark as one that has already started', () => {
    const written = join(directory, 'shell-state.json')
    writeFileSync(
      written,
      JSON.stringify({
        version: 1,
        workspaces: [{ id: 'w', path: '/repos/crucible' }],
        sessions: [
          { id: 'older', workspaceId: 'w', createdAt: 'now', token: 'opaque-1' },
          { id: 'marked', workspaceId: 'w', createdAt: 'now', fresh: true },
          { id: 'unmarked', workspaceId: 'w', createdAt: 'now', fresh: false },
          { id: 'nonsense', workspaceId: 'w', createdAt: 'now', fresh: 'yes' }
        ],
        activeSessionByWorkspace: {}
      })
    )

    const store = createShellStore(written)

    expect(store.session('older')?.fresh).toBeUndefined()
    expect(store.session('older')?.token).toBe('opaque-1')
    expect(store.session('marked')?.fresh).toBe(true)
    expect(store.session('unmarked')?.fresh).toBeUndefined()
    expect(store.session('nonsense')?.fresh).toBeUndefined()
  })

  it('loads a worktree that does not read as one as absent, session intact', () => {
    const written = join(directory, 'shell-state.json')
    writeFileSync(
      written,
      JSON.stringify({
        version: 1,
        workspaces: [{ id: 'w', path: '/repos/crucible' }],
        sessions: [
          { id: 'listy', workspaceId: 'w', createdAt: 'now', worktree: ['/somewhere'] },
          { id: 'pathless', workspaceId: 'w', createdAt: 'now', worktree: { branch: 'crucible/x' } },
          {
            id: 'branchless',
            workspaceId: 'w',
            createdAt: 'now',
            worktree: { path: '/w/9f3a2c', branch: 7 }
          }
        ],
        activeSessionByWorkspace: {}
      })
    )

    const store = createShellStore(written)

    // The directory on disk is untouched either way: what is lost here is a
    // field, and the session still opens.
    expect(store.session('listy')?.worktree).toBeUndefined()
    expect(store.session('listy')?.createdAt).toBe('now')
    expect(store.session('pathless')?.worktree).toBeUndefined()
    expect(store.session('branchless')?.worktree).toEqual({ path: '/w/9f3a2c' })
  })

  it('loads panel data that does not read as panel data as absent', () => {
    // The rest of the record is intact, so only the panel is lost: a version
    // bump would have thrown the whole sidebar away instead.
    const written = join(directory, 'shell-state.json')
    writeFileSync(
      written,
      JSON.stringify({
        version: 1,
        workspaces: [{ id: 'w', path: '/repos/crucible' }],
        sessions: [
          { id: 's', workspaceId: 'w', createdAt: 'now', panel: { tabs: 'not a list' } }
        ],
        activeSessionByWorkspace: {}
      })
    )

    const store = createShellStore(written)

    expect(store.session('s')?.panel).toBeUndefined()
    expect(store.session('s')?.createdAt).toBe('now')
  })

  it('opens empty rather than refusing to launch on a file it cannot read', () => {
    const broken = join(directory, 'shell-state.json')
    writeFileSync(broken, 'not json at all')

    const store = createShellStore(broken)

    expect(store.state.workspaces).toEqual([])
    expect(store.state.sessions).toEqual([])
  })

  it('ignores a file written by a version it does not know', () => {
    const future = join(directory, 'shell-state.json')
    writeFileSync(future, JSON.stringify({ version: 99, workspaces: [{ id: 'w', path: '/x' }] }))

    expect(createShellStore(future).state.workspaces).toEqual([])
  })

  it('reports a write it could not make instead of throwing at a caller', () => {
    const failures: unknown[] = []
    // A path whose parent is a file, which no `mkdir` can fix.
    writeFileSync(join(directory, 'blocked'), 'x')
    const store = createShellStore(join(directory, 'blocked', 'state.json'), (cause) =>
      failures.push(cause)
    )

    const workspace = store.addWorkspace('/repos/crucible')

    expect(workspace.path).toBe('/repos/crucible')
    expect(store.state.workspaces).toHaveLength(1)
    expect(failures).toHaveLength(1)
  })
})

describe('workspaces', () => {
  it('activates the workspace already holding a folder rather than adding it twice', () => {
    const store = createShellStore(file)
    const first = store.addWorkspace('/repos/crucible')
    store.addWorkspace('/repos/homelab')

    const again = store.addWorkspace('/repos/crucible')

    expect(again.id).toBe(first.id)
    expect(store.state.workspaces).toHaveLength(2)
    expect(store.state.activeWorkspaceId).toBe(first.id)
  })

  it('takes its sessions with it when it is removed, and picks another', () => {
    const store = createShellStore(file)
    const doomed = store.addWorkspace('/repos/crucible')
    const kept = store.addWorkspace('/repos/homelab')
    store.addSession({ workspaceId: doomed.id, createdAt: 'now' })
    const survivor = store.addSession({ workspaceId: kept.id, createdAt: 'now' })

    store.removeWorkspace(doomed.id)

    expect(store.state.workspaces).toEqual([{ id: kept.id, path: '/repos/homelab' }])
    expect(store.state.sessions.map((session) => session.id)).toEqual([survivor.id])
  })
})

describe('sessions', () => {
  it('falls back to another session of the workspace when the active one goes', () => {
    const store = createShellStore(file)
    const workspace = store.addWorkspace('/repos/crucible')
    const first = store.addSession({ workspaceId: workspace.id, createdAt: 'now' })
    const second = store.addSession({ workspaceId: workspace.id, createdAt: 'now' })

    store.removeSession(second.id)

    expect(store.activeSessionId()).toBe(first.id)
  })

  it('leaves the workspace with no active session when its last one goes', () => {
    const store = createShellStore(file)
    const workspace = store.addWorkspace('/repos/crucible')
    const only = store.addSession({ workspaceId: workspace.id, createdAt: 'now' })

    store.removeSession(only.id)

    expect(store.activeSessionId()).toBeUndefined()
    expect(store.state.activeWorkspaceId).toBe(workspace.id)
  })

  it('remembers the active session of each workspace separately', () => {
    const store = createShellStore(file)
    const left = store.addWorkspace('/repos/crucible')
    const leftSession = store.addSession({ workspaceId: left.id, createdAt: 'now' })
    const right = store.addWorkspace('/repos/homelab')
    const rightSession = store.addSession({ workspaceId: right.id, createdAt: 'now' })

    store.activateWorkspace(left.id)
    expect(store.activeSessionId()).toBe(leftSession.id)

    store.activateWorkspace(right.id)
    expect(store.activeSessionId()).toBe(rightSession.id)
  })

  it('keeps the identity and changes the token when a session is rebound', () => {
    const store = createShellStore(file)
    const workspace = store.addWorkspace('/repos/crucible')
    const session = store.addSession({
      workspaceId: workspace.id,
      createdAt: 'now',
      token: 'old',
      tokenFlavor: 'sdk'
    })

    store.updateSession(session.id, {
      token: 'new',
      tokenFlavor: 'fake',
      model: 'fake/deterministic'
    })

    expect(createShellStore(file).session(session.id)).toEqual({
      id: session.id,
      workspaceId: workspace.id,
      createdAt: 'now',
      token: 'new',
      tokenFlavor: 'fake',
      model: 'fake/deterministic'
    })
  })
})

describe('when a workspace was last used', () => {
  it('is absent until something is used in it, adding it included', () => {
    const store = createShellStore(file)
    const workspace = store.addWorkspace('/repos/crucible')
    store.addSession({ workspaceId: workspace.id, createdAt: 'now' })
    store.activateWorkspace(workspace.id)

    expect(store.workspace(workspace.id)?.lastUsedAt).toBeUndefined()
    expect(createShellStore(file).workspace(workspace.id)?.lastUsedAt).toBeUndefined()
  })

  it('is stamped by recordUse and survives a relaunch', () => {
    const store = createShellStore(file)
    const workspace = store.addWorkspace('/repos/crucible')

    store.recordUse(workspace.id)

    const stamped = store.workspace(workspace.id)?.lastUsedAt
    expect(stamped).toBeDefined()
    expect(createShellStore(file).workspace(workspace.id)?.lastUsedAt).toBe(stamped)
  })

  it('never moves backwards', () => {
    const written = join(directory, 'shell-state.json')
    writeFileSync(
      written,
      JSON.stringify({
        version: 1,
        workspaces: [{ id: 'w', path: '/repos/crucible', lastUsedAt: '2099-01-01T00:00:00.000Z' }],
        sessions: [],
        activeSessionByWorkspace: {}
      })
    )
    const store = createShellStore(written)

    store.recordUse('w')

    expect(store.workspace('w')?.lastUsedAt).toBe('2099-01-01T00:00:00.000Z')
  })

  it('leaves a workspace that is gone alone rather than minting one', () => {
    const store = createShellStore(file)

    store.recordUse('never-was')

    expect(store.state.workspaces).toEqual([])
  })

  it('stands where it was after the session it came from is forgotten', () => {
    const store = createShellStore(file)
    const workspace = store.addWorkspace('/repos/crucible')
    const session = store.addSession({ workspaceId: workspace.id, createdAt: 'now' })
    store.recordUse(workspace.id)
    const stamped = store.workspace(workspace.id)?.lastUsedAt

    store.removeSession(session.id)

    expect(store.workspace(workspace.id)?.lastUsedAt).toBe(stamped)
  })

  it('is seeded once from the sessions of a record that has none', () => {
    const written = join(directory, 'shell-state.json')
    writeFileSync(
      written,
      JSON.stringify({
        version: 1,
        workspaces: [
          { id: 'w1', path: '/repos/crucible' },
          { id: 'w2', path: '/repos/camping' }
        ],
        sessions: [
          { id: 's1', workspaceId: 'w1', createdAt: 'then', lastActivityAt: '2026-09-01T10:00:00.000Z' },
          { id: 's2', workspaceId: 'w1', createdAt: 'then', lastActivityAt: '2026-09-06T10:00:00.000Z' },
          { id: 's3', workspaceId: 'w2', createdAt: 'then' }
        ],
        activeSessionByWorkspace: {}
      })
    )

    const store = createShellStore(written)

    expect(store.workspace('w1')?.lastUsedAt).toBe('2026-09-06T10:00:00.000Z')
    expect(store.workspace('w2')?.lastUsedAt).toBeUndefined()
  })

  it('leaves a stamp already on the record alone', () => {
    const written = join(directory, 'shell-state.json')
    writeFileSync(
      written,
      JSON.stringify({
        version: 1,
        workspaces: [{ id: 'w1', path: '/repos/crucible', lastUsedAt: '2026-09-08T09:00:00.000Z' }],
        sessions: [
          { id: 's1', workspaceId: 'w1', createdAt: 'then', lastActivityAt: '2026-09-01T10:00:00.000Z' }
        ],
        activeSessionByWorkspace: {}
      })
    )

    expect(createShellStore(written).workspace('w1')?.lastUsedAt).toBe('2026-09-08T09:00:00.000Z')
  })
})
