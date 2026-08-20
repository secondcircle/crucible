// @vitest-environment node
//
// A run offered to a live turn the adapter could not take ('idle' — the
// window the SDK adapter documents between a prompt being accepted and π
// starting to stream) waits that turn out. When the wait ends because the
// user stopped the turn, the run must stay local and the share must answer
// 'dropped': "Never delivered after a stop: nothing auto-fires at a plan the
// user killed" (spec §3.1, Q14 carried; §45's 'dropped' drawer state).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ConversationAdapter } from '../../shared/agent/adapter'
import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import type { BashRunShare, PortEvent } from '../../shared/agent/port'
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

it('a run waiting out a turn the user stopped stays local and answers dropped', async () => {
  const inner = createFakeAdapter({ pauseMs: 0 })

  // A turn that runs until the user stops it.
  let releaseTurn: (() => void) | undefined
  const turnGate = new Promise<void>((resolve) => {
    releaseTurn = resolve
  })
  const bashRunTurns: BashRunShare[] = []

  const adapter: ConversationAdapter = {
    ...inner,
    async prompt(): Promise<void> {
      await turnGate
    },
    // The SDK adapter's own documented window: the shell's turn is live, but
    // no live run at the adapter could take the share, so it answers 'idle'.
    async shareBashRun(): Promise<'delivered' | 'dropped' | 'idle'> {
      return 'idle'
    },
    async promptBashRun(_sessionId, _turnId, run): Promise<void> {
      bashRunTurns.push(run)
    },
    async cancel(): Promise<void> {
      releaseTurn?.()
    }
  }

  shell = createShell({
    store: createShellStore(join(directory, 'shell-state.json')),
    adapter,
    pickFolder: async () => '/repos/crucible'
  })
  const events: PortEvent[] = []
  shell.onEvent((event) => events.push(event))

  const workspaceId = await shell.addWorkspace()
  if (workspaceId === null) throw new Error('the picker was supposed to answer')
  const sessionId = await shell.createSession(workspaceId)

  await shell.prompt(sessionId, 'work on it')
  await settled() // the dispatch has reached the adapter; the turn is live

  const share = shell.shareBashRun(sessionId, {
    command: 'git status',
    output: 'clean\n',
    exitCode: 0
  })
  await settled() // the share was offered, answered 'idle', and now waits

  // The user kills the plan.
  await shell.cancel(sessionId)
  await settled()

  await expect(share).resolves.toBe('dropped')
  expect(events.map((event) => event.type)).not.toContain('bash_run_shared')
  expect(bashRunTurns).toEqual([])
})
