// The sizes a compaction's rules work to. None of them is a setting: the
// Settings section is the switch and the threshold, and everything here is
// the implementation's own.
//
// Nothing here caps what a compaction produces. The summary is as long as the
// model makes it, and nothing of the compacted span is kept verbatim:
// everything up to the moment the compaction was asked for is summarized, and
// only what arrives after it is verbatim. A build before this one kept a 20k
// tail and trimmed a skeleton to 20k, and both were arbitrary: the tail was
// the largest part of a 65k result.

// What a compaction is expected to leave behind, before this conversation has
// had one. Measured, a summary of a day's work runs a few thousand tokens to
// a few tens of thousands. Once a conversation has compacted, what its own
// last compaction actually produced replaces this.
export const EXPECTED_COMPACTED_TOKENS = 20_000

// How close to the model's own window counts as the edge. π's own
// `reserveTokens` default: room for the reply that is about to be generated.
export const WINDOW_EDGE_RESERVE_TOKENS = 16_384

// Both numbers above were measured against a 200k-plus window, and π's
// catalog is full of 8k, 16k and 32k models. Left absolute they describe a
// window the model does not have: a 16k reserve puts the edge at half of a
// 32k model. So each is capped at a share of the window it has to fit inside,
// and the wide-window figure stands wherever there is room for it.
const WINDOW_SHARE = 4

function share(contextWindow: number | undefined): number {
  const window = contextWindow ?? 0
  // No reported window is not a small one: nothing to measure against, so the
  // wide-window figures stand.
  return window > 0 ? Math.floor(window / WINDOW_SHARE) : Number.POSITIVE_INFINITY
}

/** How much of this model's window is held back for the reply. */
export function windowEdgeReserveTokens(contextWindow?: number): number {
  return Math.min(WINDOW_EDGE_RESERVE_TOKENS, share(contextWindow))
}

/** What a compaction of a conversation on this model is expected to leave. */
export function compactedWindowTokens(contextWindow?: number): number {
  return Math.min(EXPECTED_COMPACTED_TOKENS, share(contextWindow))
}

// What a compaction of this conversation would leave it at: the expectation
// above, or — once it has compacted at least once — what its own last
// compaction actually produced, which is the honest number. A conversation
// whose summary the model writes long compacts to more than the expectation,
// and only the model decides what it keeps.
function compactionWouldLeave(contextWindow?: number, compactedTo?: number): number {
  return Math.max(compactedWindowTokens(contextWindow), compactedTo ?? 0)
}

// The smallest conversation a compaction wins anything worth its model call
// on: twice what the compaction would leave it at. Compactions are rare and
// large — each one is a whole-context request and a broken prefix — so one
// buys at least half the conversation back. Below this the model call costs
// more than the window it wins, which is the incremental trimming the research
// rejected, and where the conversation has compacted before it is also what
// keeps it from buying the same window again on the next turn.
export function smallestWorthCompacting(contextWindow?: number, compactedTo?: number): number {
  return 2 * compactionWouldLeave(contextWindow, compactedTo)
}

// The same figure for a conversation on no particular model, which is what the
// threshold setting is floored at. The setting is machine-global and knows no
// model, and one fact rather than two is what keeps the low end of the field
// from asking for a compaction that lands over the number the user typed: at
// the minimum, a compaction that meets its expectation leaves half the
// threshold.
export const SMALLEST_WORTH_COMPACTING = smallestWorthCompacting()

/** π's estimate, mirrored: conservative, and the same chars/4 everywhere. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
