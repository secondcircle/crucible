// @vitest-environment node
//
// Reproduction left by review: a cancel handled while the session's accepted
// turn is still waiting on its bind is silently dropped, and the turn then
// runs to a normal end.
//
// The port contract (spec 2.3, port.ts): `cancel(sessionId)` affects at most
// the live turn of that session at the moment it is handled — and a turn is
// live from the moment its prompt is accepted: `prompt()` has resolved with a
// minted TurnId, the snapshot says `working: true`, and the composer shows
// Stop. The shell's `stop()` only forwards to `adapter.cancel()`, which finds
// nothing running because `adapter.prompt()` has not been called yet, so the
// user's Stop does nothing and the turn streams on (CAN-1; in the SDK flavor
// that stream is paid, CAN-6).
//
// The window is real in the app: a session restored from a previous launch is
// bound lazily, and an SDK bind is seconds long (dynamic SDK import, settings,
// resource-loader reload, ModelRuntime.create, session open). A prompt sent in
// that window waits on the same bind, with Stop shown and inert.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { BindRequest, Binding, ConversationAdapter } from '../../shared/agent/adapter'
import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import type { PortEvent } from '../../shared/agent/port'
import { createShell, type Shell } from './shell'
import { createShellStore } from './store'

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
    store: createShellStore(file),
    adapter: createFakeAdapter({ pauseMs: 0 }),
    pickFolder: async () => '/repos/crucible'
  })
  const workspaceId = await first.addWorkspace()
  if (workspaceId === null) throw new Error('the picker was supposed to answer')
  const sessionId = await first.createSession(workspaceId)
  first.dispose()

  // Second launch: same store, so the session rebinds lazily — through an
  // adapter whose bind resolves only when the test says so, which is the shape
  // of a real SDK bind.
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
    store: createShellStore(file),
    adapter: slowToBind,
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

  // The bind completes afterwards.
  releaseBind?.()
  await settled()

  const terminals = events
    .map((event) => event.type)
    .filter((type) => type === 'turn_ended' || type === 'turn_cancelled' || type === 'turn_error')
  expect(terminals).toEqual(['turn_cancelled'])
})
