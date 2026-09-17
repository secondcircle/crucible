// Review 2, finding 4. Delete this file with the fix.
//
// "With the switch off, a conversation that reaches its model's window edge
// still compacts once as a last resort rather than erroring on every send …
// Rejected: 'off' meaning a dead conversation at the edge." π's own
// auto-compaction is switched off in every loop Crucible starts, so this is
// the only thing standing between such a conversation and an error on every
// send. `sizeTrigger` returns early below 40,000 tokens, before it looks at
// the window at all, so on any model whose window is smaller than
// SMALLEST_WORTH_COMPACTING + WINDOW_EDGE_RESERVE_TOKENS (56,384) the last
// resort never fires. π's catalog carries plenty of them: 4k, 8k, 16k, 32k
// and 40k windows all appear in `pi-ai`'s provider data.
import { describe, expect, it } from 'vitest'
import type { CompactionSettings } from './settings'
import { sizeTrigger } from './trigger'

const ON: CompactionSettings = { enabled: true, thresholdK: 200 }

describe('a model with a small context window', () => {
  it('still compacts at its own window edge', () => {
    // A 32k-window model with 30k in the window: past the edge, and the next
    // send is the one the provider refuses.
    expect(sizeTrigger(ON, { usedTokens: 30_000, contextWindow: 32_768 })).toBe('windowEdge')
  })
})
