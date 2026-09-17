// @vitest-environment node
//
// Review 3's reproduction: what happens on the turn after a compaction that
// landed above the threshold. Delete this file with the fix.
//
// The harness is the builder's own (shell.compaction.test.ts), driven through
// the fake adapter, whose `compact` is the shared `planCompaction` /
// `settleCompaction` with a canned model reply — so what it produces is what
// the real path produces, minus the model's strike list.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import type { PortEvent, SessionId } from '../../shared/agent/port'
import { MIN_THRESHOLD_K } from '../../shared/compaction/settings'
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

function build(): void {
  const store = createShellStore(join(directory, 'shell-state.json'))
  events = []
  const recorder: CacheRecorder = {
    retention: '1h',
    ledgerPath: join(directory, 'cache-misses.jsonl'),
    append: async () => {}
  }
  shell = createShell({
    store,
    panel: createPanelModel({ persistence: storePanelPersistence(store) }),
    questions: createQuestionsModel(),
    adapter: createFakeAdapter({ pauseMs: 0 }),
    flavor: 'fake',
    pickFolder: async () => WORKSPACE,
    cache: recorder
  })
  shell.onEvent((event) => events.push(event))
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function turn(sessionId: SessionId, text: string): Promise<void> {
  await shell.prompt(sessionId, text)
  await settled()
}

function compactions(): Extract<PortEvent, { type: 'compacted' }>[] {
  return events.filter(
    (event): event is Extract<PortEvent, { type: 'compacted' }> => event.type === 'compacted'
  )
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'crucible-shell-compaction-review-'))
  build()
})

afterEach(() => {
  shell.dispose()
  rmSync(directory, { recursive: true, force: true })
})

// "Compactions are rare and large, never incremental: each one is a cache
// break, and the research shows frequent small rewrites cost more than they
// save."
//
// A compaction whose result is still over the threshold is not a conversation
// that can be helped by compacting again: the next one keeps the same recent
// span and the same skeleton and lands at the same size. The `compactedTo`
// guard stops the immediate repeat and nothing stops the next turn's: one
// token of growth re-arms it, so every turn from here spends a whole-context
// model request and breaks the prefix it just wrote.
it('does not compact again on every turn after a compaction that landed over the threshold', async () => {
  const workspaceId = await shell.addWorkspace()
  if (workspaceId === null) throw new Error('the picker was supposed to answer')
  const sessionId = await shell.createSession(workspaceId)
  await turn(sessionId, LONG)
  await turn(sessionId, 'a short follow-up')
  await shell.setCompactionSettings({ enabled: true, thresholdK: MIN_THRESHOLD_K })

  await turn(sessionId, 'and the next thing')
  const first = compactions()
  expect(first).toHaveLength(1)
  // The compaction could not get under the threshold: what it kept is the
  // recent span plus a skeleton of words it may not drop.
  expect(first[0]?.record.tokensAfter).toBeGreaterThan(MIN_THRESHOLD_K * 1_000)

  await turn(sessionId, 'one more turn')
  await turn(sessionId, 'and another')

  expect(compactions()).toHaveLength(1)
})
