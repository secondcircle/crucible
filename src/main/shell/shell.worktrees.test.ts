// @vitest-environment node
//
// A session works in its workspace's checkout or in a worktree of its own, and
// the shell is where that choice is guarded. Driven against the real fake
// adapter and a real store, with no Electron and no IPC.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConversationAdapter } from '../../shared/agent/adapter'
import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import type { SessionId, SessionState } from '../../shared/agent/port'
import { createPanelModel } from '../panel/model'
import { storePanelPersistence } from '../panel/store-persistence'
import { createShell, type Shell } from './shell'
import { createShellStore } from './store'

const WORKSPACE = '/repos/crucible'

let directory: string
let file: string
/** A real directory, so what removal leaves alone can be looked at. */
let worktreePath: string
let adapter: ConversationAdapter
let shell: Shell
/** Set where a test wants the rebind a flip needs to fail. */
let refuseBind: string | undefined
/** Set where a test wants to look at a session while its rebind is in flight. */
let holdBind: boolean
let releaseBind: (() => void) | undefined
/** Every held bind, oldest first, where a test needs to land them in order. */
let heldBinds: Array<() => void>

function build(): void {
  const fake = createFakeAdapter({ pauseMs: 0 })
  adapter = {
    ...fake,
    async bind(request) {
      if (refuseBind !== undefined) throw new Error(refuseBind)
      if (holdBind) {
        await new Promise<void>((resolve) => {
          releaseBind = resolve
          heldBinds.push(resolve)
        })
      }
      return fake.bind(request)
    }
  }
  const store = createShellStore(file)
  shell = createShell({
    store,
    panel: createPanelModel({ persistence: storePanelPersistence(store) }),
    adapter,
    flavor: 'fake',
    pickFolder: async () => WORKSPACE
  })
}

async function freshSession(): Promise<{ workspaceId: string; sessionId: SessionId }> {
  const workspaceId = await shell.addWorkspace()
  if (workspaceId === null) throw new Error('the picker was supposed to answer')
  const sessionId = await shell.createSession(workspaceId)
  return { workspaceId, sessionId }
}

async function sessionOf(id: SessionId): Promise<SessionState> {
  const found = (await shell.snapshot()).sessions.find((session) => session.id === id)
  if (found === undefined) throw new Error(`no session ${id} in the snapshot`)
  return found
}

/** What the store on disk says, read the way a relaunch reads it. */
function stored(id: SessionId): { fresh?: boolean; worktree?: { path: string } } | undefined {
  return createShellStore(file).session(id)
}

const worktree = (): { path: string; branch: string } => ({
  path: worktreePath,
  branch: 'crucible/9f3a2c'
})

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'crucible-worktree-shell-'))
  file = join(directory, 'shell-state.json')
  worktreePath = join(directory, 'worktrees', '9f3a2c')
  mkdirSync(worktreePath, { recursive: true })
  refuseBind = undefined
  holdBind = false
  releaseBind = undefined
  heldBinds = []
  build()
})

afterEach(() => {
  shell.dispose()
  rmSync(directory, { recursive: true, force: true })
})

describe('choosing where a session works', () => {
  it('starts every new session fresh, on the checkout', async () => {
    const { sessionId } = await freshSession()

    expect(await sessionOf(sessionId)).toMatchObject({ fresh: true })
    expect((await sessionOf(sessionId)).worktree).toBeUndefined()
  })

  it('attaches a worktree and works there from then on', async () => {
    const { workspaceId, sessionId } = await freshSession()

    await shell.setWorktree(sessionId, worktree())
    await shell.prompt(sessionId, 'a sentence said in the worktree')
    await settled()

    expect(await sessionOf(sessionId)).toMatchObject({ worktree: worktree() })
    // The conversation is rooted in the worktree, not in the checkout the
    // session was created on.
    expect(await adapter.searchHistory(worktreePath, 'said in the worktree')).toHaveLength(1)
    expect(await adapter.searchHistory(WORKSPACE, 'said in the worktree')).toHaveLength(0)
    // Only the session's own directory moved: history search is still the
    // workspace's.
    expect(await shell.searchHistory(workspaceId, 'said in the worktree')).toHaveLength(0)
  })

  it('carries the session’s model and thinking level into the rebind', async () => {
    const { sessionId } = await freshSession()
    await shell.setThinkingLevel(sessionId, 'high')

    await shell.setWorktree(sessionId, worktree())

    expect(await sessionOf(sessionId)).toMatchObject({
      model: 'fake/deterministic',
      thinkingLevel: 'high',
      fresh: true
    })
  })

  it('puts a session back on its checkout, and leaves the worktree on disk', async () => {
    const { sessionId } = await freshSession()
    await shell.setWorktree(sessionId, worktree())

    await shell.setWorktree(sessionId)
    await shell.prompt(sessionId, 'a sentence said back in the checkout')
    await settled()

    expect((await sessionOf(sessionId)).worktree).toBeUndefined()
    expect(await adapter.searchHistory(WORKSPACE, 'back in the checkout')).toHaveLength(1)
    expect(existsSync(worktreePath)).toBe(true)
  })

  it('remembers the worktree across a relaunch', async () => {
    const { sessionId } = await freshSession()
    await shell.setWorktree(sessionId, worktree())

    shell.dispose()
    build()

    expect(await sessionOf(sessionId)).toMatchObject({ worktree: worktree(), fresh: true })
  })

  it('refuses a session it does not know', async () => {
    await expect(shell.setWorktree('never-existed', worktree())).rejects.toThrow(
      /no longer open/
    )
  })
})

describe('the lock', () => {
  it('ends freshness on the first message, and writes it down at once', async () => {
    const { sessionId } = await freshSession()

    await shell.prompt(sessionId, 'the first message')

    // Written before the turn is over, so a crash after it still loads locked.
    expect(stored(sessionId)?.fresh).toBeUndefined()
    expect(await sessionOf(sessionId)).toMatchObject({ fresh: false })
    await settled()
  })

  it('ends freshness on a queued message that became the next prompt', async () => {
    const { sessionId } = await freshSession()

    await shell.steer(sessionId, 'a message with no turn to take it')
    await settled()

    expect(await sessionOf(sessionId)).toMatchObject({ fresh: false })
  })

  it('ends freshness on a bash run added with nothing running', async () => {
    const { sessionId } = await freshSession()

    await shell.shareBashRun(sessionId, { command: 'git status', output: 'clean\n', exitCode: 0 })
    await settled()

    expect(await sessionOf(sessionId)).toMatchObject({ fresh: false })
  })

  it('refuses a worktree change once the session has started', async () => {
    const { sessionId } = await freshSession()
    await shell.prompt(sessionId, 'the first message')
    await settled()

    await expect(shell.setWorktree(sessionId, worktree())).rejects.toThrow(/already started/)
    expect((await sessionOf(sessionId)).worktree).toBeUndefined()
  })

  it('refuses to detach a session that has started, too', async () => {
    const { sessionId } = await freshSession()
    await shell.setWorktree(sessionId, worktree())
    await shell.prompt(sessionId, 'the first message')
    await settled()

    await expect(shell.setWorktree(sessionId)).rejects.toThrow(/already started/)
    expect(await sessionOf(sessionId)).toMatchObject({ worktree: worktree() })
  })

  it('is locked for a resumed conversation, which starts on the checkout', async () => {
    const { workspaceId, sessionId } = await freshSession()
    await shell.prompt(sessionId, 'a conversation worth resuming')
    await settled()
    await shell.resetSession(sessionId)
    const [match] = await shell.searchHistory(workspaceId, 'worth resuming')

    const resumed = await shell.resumeSession(workspaceId, match.ref)

    expect(await sessionOf(resumed)).toMatchObject({ fresh: false })
    expect((await sessionOf(resumed)).worktree).toBeUndefined()
  })
})

describe('a reset', () => {
  it('gives the choice back and keeps the session in its worktree', async () => {
    const { sessionId } = await freshSession()
    await shell.setWorktree(sessionId, worktree())
    await shell.prompt(sessionId, 'before the reset')
    await settled()

    await shell.resetSession(sessionId)

    expect(await sessionOf(sessionId)).toMatchObject({ fresh: true, worktree: worktree() })
    expect(stored(sessionId)?.fresh).toBe(true)
    // The fresh conversation is rooted in the worktree, exactly as the old one
    // was, and the directory is untouched.
    await shell.prompt(sessionId, 'after the reset')
    await settled()
    expect(await adapter.searchHistory(worktreePath, 'after the reset')).toHaveLength(1)
    expect(existsSync(worktreePath)).toBe(true)
  })

  it('lets the session go back to the checkout afterwards', async () => {
    const { sessionId } = await freshSession()
    await shell.setWorktree(sessionId, worktree())
    await shell.prompt(sessionId, 'before the reset')
    await settled()
    await shell.resetSession(sessionId)

    await shell.setWorktree(sessionId)

    expect((await sessionOf(sessionId)).worktree).toBeUndefined()
  })
})

describe('when the rebind fails', () => {
  it('leaves the session exactly where it was', async () => {
    const { sessionId } = await freshSession()
    refuseBind = 'That conversation could not be opened.'

    await expect(shell.setWorktree(sessionId, worktree())).rejects.toThrow(/could not be opened/)

    refuseBind = undefined
    expect((await sessionOf(sessionId)).worktree).toBeUndefined()
    expect(stored(sessionId)?.worktree).toBeUndefined()
    expect(await sessionOf(sessionId)).toMatchObject({ fresh: true })
    // Still usable: the next thing it is asked to do binds it again.
    await shell.prompt(sessionId, 'a sentence said after the failure')
    await settled()
    expect(await adapter.searchHistory(WORKSPACE, 'after the failure')).toHaveLength(1)
  })
})

describe('while the rebind is in flight', () => {
  it('refuses a message, rather than answering it in the wrong directory', async () => {
    const { sessionId } = await freshSession()
    holdBind = true
    const flip = shell.setWorktree(sessionId, worktree())
    await settled()

    await expect(shell.prompt(sessionId, 'too early')).rejects.toThrow(/settling where it works/)

    holdBind = false
    releaseBind?.()
    await flip
    // And the moment it has settled, the message lands where it belongs.
    await shell.prompt(sessionId, 'a sentence said once it settled')
    await settled()
    expect(await adapter.searchHistory(worktreePath, 'once it settled')).toHaveLength(1)
  })

  it('writes nothing when the session was removed meanwhile', async () => {
    const { sessionId } = await freshSession()
    holdBind = true
    const flip = shell.setWorktree(sessionId, worktree())
    await settled()

    await shell.removeSession(sessionId)
    holdBind = false
    releaseBind?.()
    await flip

    expect((await shell.snapshot()).sessions).toEqual([])
    expect(stored(sessionId)).toBeUndefined()
    expect(existsSync(worktreePath)).toBe(true)
  })
})

describe('a conversation opened during the flip', () => {
  // Anything that needs the conversation while the flip's rebind is in
  // flight — opening the session tree, changing the model, fetching the
  // transcript — starts a second bind from the not-yet-updated record. When
  // that stale bind lands after the flip's own, it must not hand the session
  // back to the checkout conversation.
  it('does not point a worktree session back at the checkout conversation', async () => {
    const { sessionId } = await freshSession()
    holdBind = true

    const flip = shell.setWorktree(sessionId, worktree())
    await settled()
    const tree = shell.sessionTree(sessionId)
    await settled()
    expect(heldBinds).toHaveLength(2)

    // The flip's own rebind lands first; the stale bind lands after it.
    heldBinds.shift()?.()
    await settled()
    holdBind = false
    heldBinds.shift()?.()
    await flip
    await tree

    await shell.prompt(sessionId, 'a sentence said after the flip')
    await settled()

    // The record says the worktree, so the words must be rooted there too.
    expect(await sessionOf(sessionId)).toMatchObject({ worktree: worktree() })
    expect(await adapter.searchHistory(worktreePath, 'after the flip')).toHaveLength(1)
    expect(await adapter.searchHistory(WORKSPACE, 'after the flip')).toHaveLength(0)
  })
})

describe('what never touches a worktree', () => {
  it('forgets the session record on removal and leaves the directory alone', async () => {
    const { workspaceId, sessionId } = await freshSession()
    await shell.setWorktree(sessionId, worktree())
    await shell.prompt(sessionId, 'work done in the worktree')
    await settled()

    await shell.removeSession(sessionId)

    expect((await shell.snapshot()).sessions).toEqual([])
    expect(stored(sessionId)).toBeUndefined()
    expect(existsSync(worktreePath)).toBe(true)
    // The conversation is still the adapter's to find, in the worktree it
    // happened in.
    expect(await adapter.searchHistory(worktreePath, 'work done')).toHaveLength(1)
    expect(await shell.searchHistory(workspaceId, 'work done')).toHaveLength(0)
  })

  it('leaves it alone when the workspace itself is removed', async () => {
    const { workspaceId, sessionId } = await freshSession()
    await shell.setWorktree(sessionId, worktree())

    await shell.removeWorkspace(workspaceId)
    await settled()

    expect((await shell.snapshot()).sessions).toEqual([])
    expect(existsSync(worktreePath)).toBe(true)
  })
})

// The fake adapter is built with no pause, so one macrotask turn is past its
// whole script however long that grows.
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
