// The sizes a compaction works to. None of them is a setting: the Settings
// section is the switch and the threshold, and everything here is the
// implementation's own. The numbers come from measuring real sessions — a
// 500k conversation comes back near 50k with these.

// The tail a compaction never touches, kept verbatim behind the skeleton, on
// a model with room for it. `recentSpanTokens` is what anything deciding a
// real conversation asks: on a small window this much of it is the whole
// conversation.
export const RECENT_SPAN_TOKENS = 20_000

// What the model-written trajectory summary is sized at: the length the
// instruction asks for, and what the arithmetic below assumes it took. It is
// not enforced. An account that runs long is kept whole, because nothing an
// agent writes is cut, and the next compaction rewrites it rather than adding
// to it, so a long one does not compound.
export const SUMMARY_BUDGET_TOKENS = 3_000

// What the skeleton may take after pruning. The skeleton of a 500k span is
// about 31k unpruned, and it is carried into every later compaction, so
// without a ceiling it is the one part of the window that grows without
// bound.
export const SKELETON_BUDGET_TOKENS = 20_000

// How close to the model's own window counts as the edge. π's own
// `reserveTokens` default: room for the reply that is about to be generated.
export const WINDOW_EDGE_RESERVE_TOKENS = 16_384

// Every number above was measured against a 200k-plus window, and π's catalog
// is full of 8k, 16k and 32k models. Left absolute they describe a window the
// model does not have: a 20k recent span is two thirds of a 32k model, a 16k
// reserve puts the edge at half of it, and a 20k skeleton would be most of
// what a compaction just made room in. So each is capped at a share of the
// window it has to fit inside, and the wide-window figure stands wherever
// there is room for it. A quarter each leaves a compacted window a little
// under half full, whatever the model.
const WINDOW_SHARE = 4

function share(contextWindow: number | undefined): number {
  const window = contextWindow ?? 0
  // No reported window is not a small one: nothing to measure against, so the
  // wide-window figures stand.
  return window > 0 ? Math.floor(window / WINDOW_SHARE) : Number.POSITIVE_INFINITY
}

/** What a compaction keeps verbatim behind the skeleton on this model. */
export function recentSpanTokens(contextWindow?: number): number {
  return Math.min(RECENT_SPAN_TOKENS, share(contextWindow))
}

/** How much of this model's window is held back for the reply. */
export function windowEdgeReserveTokens(contextWindow?: number): number {
  return Math.min(WINDOW_EDGE_RESERVE_TOKENS, share(contextWindow))
}

/** What the skeleton may take after pruning, on this model. */
export function skeletonBudgetTokens(contextWindow?: number): number {
  return Math.min(SKELETON_BUDGET_TOKENS, share(contextWindow))
}

// What a compaction leaves behind: the recent span it keeps verbatim, the
// skeleton at its budget and the summary at its. Nothing a compaction does
// gets a conversation below this, so it is the size the next one has to beat
// and the size every rule about whether to compact is measured from.
export function compactedWindowTokens(contextWindow?: number): number {
  return (
    recentSpanTokens(contextWindow) + skeletonBudgetTokens(contextWindow) + SUMMARY_BUDGET_TOKENS
  )
}

// What a compaction of this conversation would leave it at: the budgets above,
// or — once it has compacted at least once — what its own last compaction
// actually produced, which is the honest number where the budgets cannot be
// met. A conversation whose words alone exceed the skeleton budget compacts to
// more than the budget, and the skeleton may not drop what the user said.
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
// the minimum, a compaction that hits its budgets leaves half the threshold.
export const SMALLEST_WORTH_COMPACTING = smallestWorthCompacting()

/** π's estimate, mirrored: conservative, and the same chars/4 everywhere. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
