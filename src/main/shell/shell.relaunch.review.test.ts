// @vitest-environment node
//
// Review 4's reproduction. Delete this file with the fix.
//
// What the shell does with a conversation whose own last compaction landed
// above the threshold — after the launch that compacted it has ended. The
// rule that stops the repeat lives entirely in one launch's memory
// (`compactedTo` in the watch), so the next launch asks the same question with
// none of the answer and buys the same window again: a whole-context model
// request that takes nothing away, on a conversation that has not grown by a
// token since.
//
// Driven through the fake adapter, whose conversation store stands in for the
// session file π keeps: the launch ends, the conversation does not.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ConversationAdapter } from '../../shared/agent/adapter'
import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import type { PortEvent, SessionId } from '../../shared/agent/port'
import { MIN_THRESHOLD_K } from '../../shared/compaction/settings'
import { createPanelModel } from '../panel/model'
import { storePanelPersistence } from '../panel/store-persistence'
import { createQuestionsModel } from '../questions/model'
import { createShell, type Shell } from './shell'
import { createShellStore } from './store'

const WORKSPACE = '/repos/crucible'

// Speech alone past the threshold, which is the conversation a compaction
// cannot get under it: the skeleton keeps what was said whole and may not
// drop what the user said.
const LONG = `a long message ${'x'.repeat(440_000)}`

let directory: string
let adapter: ConversationAdapter
let shell: Shell
let events: PortEvent[]

/** One run of the app over the conversations the adapter is holding. */
function launch(): Shell {
  const store = createShellStore(join(directory, 'shell-state.json'))
  const built = createShell({
    store,
    panel: createPanelModel({ persistence: storePanelPersistence(store) }),
    questions: createQuestionsModel(),
    adapter,
    flavor: 'fake',
    pickFolder: async () => WORKSPACE,
    cache: {
      retention: '1h',
      ledgerPath: join(directory, 'cache-misses.jsonl'),
      append: async () => {}
    }
  })
  return built
}

/** The fake adapter runs its whole script inside one macrotask. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'crucible-shell-relaunch-'))
  adapter = createFakeAdapter({ pauseMs: 0 })
  events = []
})

afterEach(() => {
  shell.dispose()
  rmSync(directory, { recursive: true, force: true })
})

it('leaves a restored conversation its last compaction could not shrink alone', async () => {
  shell = launch()
  await shell.setCompactionSettings({ enabled: true, thresholdK: MIN_THRESHOLD_K })
  const workspaceId = await shell.addWorkspace()
  if (workspaceId === null) throw new Error('the picker was supposed to answer')
  const sessionId: SessionId = await shell.createSession(workspaceId)
  await shell.prompt(sessionId, LONG)
  await settled()
  await shell.prompt(sessionId, 'a short follow-up')
  await settled()

  // This launch's compaction: it ran, and it landed above the threshold,
  // because the conversation's own words are over it.
  const first = await shell.transcript(sessionId)
  const compacted = first.filter((item) => item.kind === 'summary')
  expect(compacted).toHaveLength(1)

  // The launch ends. The conversation outlives it.
  shell.dispose()
  await adapter.release(sessionId)

  shell = launch()
  shell.onEvent((event) => events.push(event))
  // Opening the session is what a launch does with the session it restores:
  // the bind reports the context the conversation came back holding.
  await shell.transcript(sessionId)
  await settled()
  await settled()

  // Nothing has been said to this conversation since the compaction above, so
  // there is nothing for a second one to take away.
  expect(events.filter((event) => event.type === 'compacted')).toEqual([])
})
