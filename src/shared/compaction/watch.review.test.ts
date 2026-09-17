// Review 3's reproduction, at the rule rather than at the shell: what the
// watch does on the turn after a compaction that landed over the threshold.
// Delete this file with the fix.
import { beforeEach, expect, it } from 'vitest'
import type { CompactionSettings } from './settings'
import type { CompactionTrigger } from './record'
import { createCompactionWatch, type CompactionWatch } from './watch'

const ON: CompactionSettings = { enabled: true, thresholdK: 40 }

let fired: { id: string; trigger: CompactionTrigger }[]
let watch: CompactionWatch

beforeEach(() => {
  fired = []
  watch = createCompactionWatch({
    settings: () => ON,
    retention: '1h',
    idle: () => true,
    compact: (id, trigger) => fired.push({ id, trigger }),
    now: () => 0,
    setTimer: () => 0,
    clearTimer: () => {}
  })
})

// The compacted window is the recent span (20k) plus the skeleton budget
// (20k) plus the summary (3k), so a compaction can legitimately land above a
// 40k threshold — 40 is the smallest number the Settings field accepts — and
// on a conversation whose words are its bulk it lands there whatever the
// budget says, because the skeleton may not drop what the user said.
//
// `compactedTo` stops the immediate repeat: the first size reported after a
// compaction is that compaction's own work. Nothing stops the next turn's.
// One token of growth clears the guard and the threshold is still crossed, so
// the conversation compacts again, and again, once per turn — each one a
// whole-context model request and a broken prefix, which is the opposite of
// "rare and large, never incremental".
it('does not fire again on every report once a compaction landed over the threshold', () => {
  watch.saw('a', { lastRequestAt: 0, usedTokens: 60_000, contextWindow: 200_000 })
  expect(fired).toEqual([{ id: 'a', trigger: 'threshold' }])

  // The compaction's own result: still over the threshold, because what it
  // kept is a recent span and a skeleton of words it may not strike.
  watch.saw('a', { lastRequestAt: 1, usedTokens: 43_000, contextWindow: 200_000 })
  // One more turn of ordinary work on top of it.
  watch.saw('a', { lastRequestAt: 2, usedTokens: 44_000, contextWindow: 200_000 })
  watch.saw('a', { lastRequestAt: 3, usedTokens: 45_000, contextWindow: 200_000 })

  expect(fired).toHaveLength(1)
})
