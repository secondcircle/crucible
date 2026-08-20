// @vitest-environment node
//
// The guards around the tree and around a shared bash run, driven against the
// real fake adapter and a real store: no Electron, no IPC.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConversationAdapter } from '../../shared/agent/adapter'
import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import type { PortEvent, SessionId } from '../../shared/agent/port'
import { createShell, type Shell } from './shell'
import { createShellStore } from './store'

const WORKSPACE = '/repos/crucible'

let directory: string
let adapter: ConversationAdapter
let shell: Shell
let events: PortEvent[]

async function withSession(): Promise<SessionId> {
  const workspaceId = await shell.addWorkspace()
  if (workspaceId === null) throw new Error('the picker was supposed to answer')
  const sessionId = await shell.createSession(workspaceId)
  // What the setup emitted is not what these tests are about.
  events.length = 0
  return sessionId
}

const types = (): string[] => events.map((event) => event.type)

/** Settles every microtask the scripted turn is made of. */
async function idle(): Promise<void> {
  for (let turn = 0; turn < 400; turn += 1) await Promise.resolve()
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'crucible-tree-'))
  adapter = createFakeAdapter({ pauseMs: 0 })
  shell = createShell({
    store: createShellStore(join(directory, 'shell-state.json')),
    adapter,
    pickFolder: async () => WORKSPACE
  })
  events = []
  shell.onEvent((event) => events.push(event))
})

afterEach(() => {
  shell.dispose()
  rmSync(directory, { recursive: true, force: true })
})

describe('the session tree', () => {
  it('binds on demand and answers while the session works', async () => {
    const sessionId = await withSession()
    await shell.prompt(sessionId, 'first')

    const tree = await shell.sessionTree(sessionId)

    expect(tree.roots.map((node) => node.text)).toEqual(['first'])
    expect(tree.path).toEqual(tree.roots.map((node) => node.ref))
  })

  it('labels a point while the session works, and reads it back', async () => {
    const sessionId = await withSession()
    await shell.prompt(sessionId, 'first')
    const [node] = (await shell.sessionTree(sessionId)).roots

    await shell.setLabel(sessionId, node?.ref ?? '', 'checkpoint')

    expect((await shell.sessionTree(sessionId)).roots[0]?.label).toBe('checkpoint')
  })
})

describe('a jump', () => {
  it('is refused while the session works, and allowed after a stop', async () => {
    const sessionId = await withSession()
    await shell.prompt(sessionId, 'first')
    const [node] = (await shell.sessionTree(sessionId)).roots
    const ref = node?.ref ?? ''

    await expect(shell.jump(sessionId, ref, { summarize: false })).rejects.toThrow(
      /working\. Stop it first/
    )

    await shell.cancel(sessionId)
    await expect(shell.jump(sessionId, ref, { summarize: false })).resolves.toEqual({
      editorText: 'first'
    })
  })

  it('mints no session and keeps the sidebar as it was', async () => {
    const sessionId = await withSession()
    await shell.prompt(sessionId, 'first')
    await idle()
    const [node] = (await shell.sessionTree(sessionId)).roots

    await shell.jump(sessionId, node?.ref ?? '', { summarize: false })

    const snapshot = await shell.snapshot()
    expect(snapshot.sessions.map((session) => session.id)).toEqual([sessionId])
    expect(snapshot.activeSessionId).toBe(sessionId)
  })
})

describe('sharing a bash run', () => {
  const RUN = { command: 'git status', output: 'nothing to commit\n', exitCode: 0 }

  it('begins a turn that announces the run after the start, never as a message', async () => {
    const sessionId = await withSession()

    const outcome = await shell.shareBashRun(sessionId, RUN)
    await idle()

    expect(outcome).toBe('delivered')
    expect(types().slice(0, 3)).toEqual(['state', 'turn_started', 'bash_run_shared'])
    expect(types()).not.toContain('user_message')
    const shared = events.find((event) => event.type === 'bash_run_shared')
    expect(shared).toMatchObject(RUN)
  })

  it('leaves the run out of the queue state and out of any flush', async () => {
    const sessionId = await withSession()
    await shell.prompt(sessionId, 'first')

    const share = shell.shareBashRun(sessionId, RUN)
    const working = await shell.snapshot()
    expect(working.sessions[0]?.queue).toBeUndefined()

    await idle()
    await expect(share).resolves.toBe('delivered')
    expect(types()).not.toContain('queue_flushed')
  })

  it('drops a run the turn was stopped before delivering, and keeps it local', async () => {
    const sessionId = await withSession()
    await shell.prompt(sessionId, 'first')
    const share = shell.shareBashRun(sessionId, RUN)

    await shell.cancel(sessionId)
    await idle()

    await expect(share).resolves.toBe('dropped')
    expect(types()).not.toContain('bash_run_shared')
    const items = await shell.transcript(sessionId)
    expect(items.some((item) => item.kind === 'bashRun')).toBe(false)
  })

  it('reaches the conversation at a tool boundary while a turn is live', async () => {
    const sessionId = await withSession()
    await shell.prompt(sessionId, 'first')

    const outcome = await shell.shareBashRun(sessionId, RUN)
    await idle()

    expect(outcome).toBe('delivered')
    const items = await shell.transcript(sessionId)
    expect(items).toContainEqual({ kind: 'bashRun', ...RUN })
    // Delivery lands inside the turn it was offered to, after work had begun.
    const at = types().indexOf('bash_run_shared')
    expect(types().slice(0, at)).toContain('tool_ended')
  })
})
