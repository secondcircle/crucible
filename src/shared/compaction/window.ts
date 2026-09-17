// The sizes a compaction works to. None of them is a setting: the Settings
// section is the switch and the threshold, and everything here is the
// implementation's own. The numbers come from measuring real sessions — a
// 500k conversation comes back near 50k with these.

// The tail a compaction never touches, kept verbatim behind the skeleton, on
// a model with room for it. `recentSpanTokens` is what anything deciding a
// real conversation asks: on a small window this much of it is the whole
// conversation.
export const RECENT_SPAN_TOKENS = 20_000

// Below this a compaction rewrites almost nothing: most of the conversation
// is the recent span, which a compaction leaves untouched anyway. It is also
// the floor under the threshold setting — one number, so a threshold the user
// types is the size their conversations actually compact at. The setting is
// machine-global and knows no model, so this is the wide-window figure;
// `smallestWorthCompacting` is the one a conversation is judged by.
export const SMALLEST_WORTH_COMPACTING = 2 * RECENT_SPAN_TOKENS

/** What the model-written trajectory summary may take. */
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

/** The size under which compacting this model's conversation gains nothing. */
export function smallestWorthCompacting(contextWindow?: number): number {
  return 2 * recentSpanTokens(contextWindow)
}

/** How much of this model's window is held back for the reply. */
export function windowEdgeReserveTokens(contextWindow?: number): number {
  return Math.min(WINDOW_EDGE_RESERVE_TOKENS, share(contextWindow))
}

/** What the skeleton may take after pruning, on this model. */
export function skeletonBudgetTokens(contextWindow?: number): number {
  return Math.min(SKELETON_BUDGET_TOKENS, share(contextWindow))
}

/** π's estimate, mirrored: conservative, and the same chars/4 everywhere. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
