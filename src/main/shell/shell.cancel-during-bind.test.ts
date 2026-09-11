// @vitest-environment node
//
// A turn is live from the moment its prompt is accepted, seconds before an SDK
// bind resolves, and a stop landing in that window has to end it anyway.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { BindRequest, Binding, ConversationAdapter } from '../../shared/agent/adapter'
import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import type { PortEvent } from '../../shared/agent/port'
import { createPanelModel, type PanelModel } from '../panel/model'
import { storePanelPersistence } from '../panel/store-persistence'
import { createQuestionsModel, type QuestionsModel } from '../questions/model'
import { createShell, type Shell } from './shell'
import { createShellStore, type ShellStore } from './store'

// The shell's panel is the app's: one model over the same store file, so what
// a panel test asserts here is what a launch does.
function over(path: string): { store: ShellStore; panel: PanelModel; questions: QuestionsModel } {
  const store = createShellStore(path)
  return {
    store,
    panel: createPanelModel({ persistence: storePanelPersistence(store) }),
    questions: createQuestionsModel()
  }
}

let directory: string
let shell: Shell | undefined

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'crucible-shell-'))
})

afterEach(() => {
  shell?.dispose()
  rmSync(directory, { recursive: true, force: true })
})

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

it('a cancel handled while the turn is still binding ends the turn as cancelled', async () => {
  const file = join(directory, 'shell-state.json')

  // First launch: one workspace, one session, persisted with its token.
  const first = createShell({
    ...over(file),
    adapter: createFakeAdapter({ pauseMs: 0 }),
    flavor: 'fake',
    pickFolder: async () => '/repos/crucible'
  })
  const workspaceId = await first.addWorkspace()
  if (workspaceId === null) throw new Error('the picker was supposed to answer')
  const sessionId = await first.createSession(workspaceId)
  first.dispose()

  // Second launch: same store, so the session rebinds lazily, through an
  // adapter whose bind resolves only when the test says so.
  const inner = createFakeAdapter({ pauseMs: 0 })
  let releaseBind: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    releaseBind = resolve
  })
  const slowToBind: ConversationAdapter = {
    ...inner,
    async bind(request: BindRequest): Promise<Binding> {
      await gate
      return inner.bind(request)
    }
  }
  shell = createShell({
    ...over(file),
    adapter: slowToBind,
    flavor: 'fake',
    pickFolder: async () => null
  })
  const events: PortEvent[] = []
  shell.onEvent((event) => events.push(event))

  // The prompt is accepted: a turn id is minted and the snapshot says the
  // session is working, so the composer is showing Stop.
  await shell.prompt(sessionId, 'hello')
  expect((await shell.snapshot()).sessions[0]?.working).toBe(true)

  // Stop, while the bind is still in flight.
  await shell.cancel(sessionId)

  releaseBind?.()
  await settled()

  const terminals = events
    .map((event) => event.type)
    .filter((type) => type === 'turn_ended' || type === 'turn_cancelled' || type === 'turn_error')
  expect(terminals).toEqual(['turn_cancelled'])
})
