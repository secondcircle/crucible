// @vitest-environment node
//
// Review 2, finding 2. Delete this file with the fix.
//
// With the switch off, the document's one stated exception is the model's own
// window edge ("With the switch off, a conversation that reaches its model's
// window edge still compacts once as a last resort"). The idle rule is not in
// that exception, and the Settings pane tells the user so in as many words:
// "Off — only the model's own window edge compacts". This drives the shell
// with the switch off and an idle conversation, and a compaction happens
// anyway: a background model request the user switched off.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import type { PortEvent, SessionId } from '../../shared/agent/port'
import type { CacheRecorder } from '../cache/ledger'
import { createPanelModel } from '../panel/model'
import { storePanelPersistence } from '../panel/store-persistence'
import { createQuestionsModel } from '../questions/model'
import { createShell, type Shell } from './shell'
import { createShellStore } from './store'

const WORKSPACE = '/repos/crucible'
const LONG = `a long message ${'x'.repeat(240_000)}`

let directory: string
let shell: Shell
let events: PortEvent[]
let clock: number
let armed: { at: number; run: () => void }[]

function advance(ms: number): void {
  clock += ms
  for (const timer of [...armed]) {
    if (timer.at > clock) continue
    armed.splice(armed.indexOf(timer), 1)
    timer.run()
  }
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function turn(sessionId: SessionId, text: string): Promise<void> {
  await shell.prompt(sessionId, text)
  await settled()
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'crucible-shell-compaction-review-'))
  clock = Date.now()
  armed = []
  events = []
  const recorder: CacheRecorder = {
    retention: '1h',
    ledgerPath: join(directory, 'cache-misses.jsonl'),
    append: async () => {}
  }
  const store = createShellStore(join(directory, 'shell-state.json'))
  shell = createShell({
    store,
    panel: createPanelModel({ persistence: storePanelPersistence(store) }),
    questions: createQuestionsModel(),
    adapter: createFakeAdapter({ pauseMs: 0 }),
    flavor: 'fake',
    pickFolder: async () => WORKSPACE,
    cache: recorder,
    compactionTimers: {
      now: () => clock,
      setTimer: (run, ms) => {
        const timer = { at: clock + ms, run }
        armed.push(timer)
        return timer
      },
      clearTimer: (handle) => {
        const at = armed.indexOf(handle as { at: number; run: () => void })
        if (at !== -1) armed.splice(at, 1)
      }
    }
  })
  shell.onEvent((event) => events.push(event))
})

afterEach(() => {
  shell.dispose()
  rmSync(directory, { recursive: true, force: true })
})

describe('an idle conversation with the switch off', () => {
  it('is left alone: nothing but the window edge compacts with the switch off', async () => {
    const workspaceId = await shell.addWorkspace()
    if (workspaceId === null) throw new Error('the picker was supposed to answer')
    const sessionId = await shell.createSession(workspaceId)
    await turn(sessionId, LONG)
    await turn(sessionId, 'a short follow-up')
    await shell.setCompactionSettings({ enabled: false, thresholdK: 200 })

    advance(51 * 60 * 1000)
    await settled()

    expect(events.filter((event) => event.type === 'compacted')).toEqual([])
  })
})
