// @vitest-environment node
//
// Providers and usage ride the agent port because they are facts about the
// agent side. Driven against the real fake adapter and a real store.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeAdapter, scaleUsage } from '../../shared/agent/fake-adapter'
import type { PortEvent, SessionId } from '../../shared/agent/port'
import { createPanelModel } from '../panel/model'
import { storePanelPersistence } from '../panel/store-persistence'
import { createShell, type Shell } from './shell'
import { createShellStore } from './store'

const WORKSPACE = '/repos/crucible'

let directory: string
let shell: Shell
let adapter: ReturnType<typeof createFakeAdapter>
let events: PortEvent[]

async function withSession(): Promise<SessionId> {
  const workspaceId = await shell.addWorkspace()
  if (workspaceId === null) throw new Error('the picker was supposed to answer')
  return shell.createSession(workspaceId)
}

/** The question on screen now, which is the latest one that crossed. */
function askedPromptId(): string {
  const asked = events.findLast((event) => event.type === 'auth_prompt')
  if (asked?.type !== 'auth_prompt') throw new Error('no question crossed the port')
  return asked.promptId
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'crucible-settings-'))
  const store = createShellStore(join(directory, 'shell-state.json'))
  adapter = createFakeAdapter({ pauseMs: 0 })
  shell = createShell({
    store,
    panel: createPanelModel({ persistence: storePanelPersistence(store) }),
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

describe('providers across the port', () => {
  it('reports what the adapter reports, in its order', async () => {
    await expect(shell.listProviders()).resolves.toEqual(await adapter.listProviders())
  })

  it('carries a login\u2019s questions through, session-less, and its answer back', async () => {
    const finished = shell.login('groq', 'api-key')

    expect(events.map((event) => event.type)).toEqual(['auth_prompt'])
    await shell.answerAuthPrompt(askedPromptId(), 'sk-anything')
    await expect(finished).resolves.toBeUndefined()

    const groq = (await shell.listProviders()).find((provider) => provider.id === 'groq')
    expect(groq?.status).toEqual({ kind: 'api-key' })
  })

  it('lets a cancel end the flow, and a failure cross as a display-safe message', async () => {
    const cancelled = shell.login('groq', 'api-key')
    await shell.cancelLogin()
    await expect(cancelled).rejects.toThrow('That login was cancelled.')

    const refused = shell.login('groq', 'api-key')
    await shell.answerAuthPrompt(askedPromptId(), '')
    await expect(refused).rejects.toThrow('That did not look like a key.')
  })

  it('logs out through to the adapter', async () => {
    await shell.logout('anthropic')

    const anthropic = (await shell.listProviders()).find(
      (provider) => provider.id === 'anthropic'
    )
    expect(anthropic?.status).toEqual({ kind: 'none' })
  })
})

describe('usage across the port', () => {
  it('folds the reported cost into the snapshot beside the tokens', async () => {
    const sessionId = await withSession()

    await shell.prompt(sessionId, 'hello')
    await new Promise((resolve) => setTimeout(resolve, 0))

    const session = (await shell.snapshot()).sessions.find(
      (candidate) => candidate.id === sessionId
    )
    expect(session?.usage).toMatchObject({ cost: 0.84 })
    expect(session?.usage?.usedTokens).toBeGreaterThan(0)
  })

  it('answers with nothing at all before a session has spent anything', async () => {
    const sessionId = await withSession()

    await expect(shell.sessionUsage(sessionId)).resolves.toBeUndefined()
  })

  it('sums a session\u2019s whole conversation, and answers nothing for a session it lost', async () => {
    const sessionId = await withSession()
    await shell.prompt(sessionId, 'hello')
    await new Promise((resolve) => setTimeout(resolve, 0))

    await expect(shell.sessionUsage(sessionId)).resolves.toEqual(scaleUsage(1))

    await shell.removeSession(sessionId)
    // A session that is no longer curated is not one the tab can ask about.
    await expect(shell.sessionUsage(sessionId)).resolves.toBeUndefined()
  })
})
