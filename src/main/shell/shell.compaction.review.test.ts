// @vitest-environment node
//
// Left failing by review-1: the reproduction for finding 3 of
// `review-1.md`. Delete this file with the fix.
//
// The size rules are only ever consulted from a usage event that carries a
// cached prefix (`shell.ts`, `watch.saw` inside `if (event.cachedPrefix !==
// undefined …)`). A conversation whose provider reports no cache activity —
// which is what `cacheMiss.ts::cachedPrefix()` answers `undefined` for —
// therefore never reaches the threshold rule and never reaches the
// window-edge last resort either.
//
// Driven through the fake adapter with its usage events stripped of the
// prefix, which is exactly the shape such a provider produces.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterEventListener, ConversationAdapter } from '../../shared/agent/adapter'
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

/** The same adapter, reporting what a provider that never caches reports. */
function withoutCachedPrefix(adapter: ConversationAdapter): ConversationAdapter {
  return {
    ...adapter,
    onEvent: (listener: AdapterEventListener) =>
      adapter.onEvent((event) => {
        if (event.type !== 'usage') return listener(event)
        const stripped = { ...event }
        delete (stripped as { cachedPrefix?: unknown }).cachedPrefix
        return listener(stripped)
      })
  }
}

async function turn(sessionId: SessionId, text: string): Promise<void> {
  await shell.prompt(sessionId, text)
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'crucible-shell-compaction-review-'))
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
    adapter: withoutCachedPrefix(createFakeAdapter({ pauseMs: 0 })),
    flavor: 'fake',
    pickFolder: async () => WORKSPACE,
    cache: recorder
  })
  shell.onEvent((event) => events.push(event))
})

afterEach(() => {
  shell.dispose()
  rmSync(directory, { recursive: true, force: true })
})

describe('a conversation whose provider reports no prompt cache', () => {
  it('still compacts when it crosses the threshold', async () => {
    const workspaceId = await shell.addWorkspace()
    if (workspaceId === null) throw new Error('the picker was supposed to answer')
    const sessionId = await shell.createSession(workspaceId)
    await shell.setCompactionSettings({ enabled: true, thresholdK: 20 })

    await turn(sessionId, LONG)
    await turn(sessionId, 'a short follow-up')
    await turn(sessionId, 'and the next thing')

    expect(events.filter((event) => event.type === 'compacted')).toHaveLength(1)
  })
})
