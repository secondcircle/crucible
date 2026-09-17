// The sizes a compaction works to. None of them is a setting: the Settings
// section is the switch and the threshold, and everything here is the
// implementation's own. The numbers come from measuring real sessions — a
// 500k conversation comes back near 50k with these.

/** The tail a compaction never touches, kept verbatim behind the skeleton. */
export const RECENT_SPAN_TOKENS = 20_000

// Below this a compaction rewrites almost nothing: most of the conversation
// is the recent span, which a compaction leaves untouched anyway. It is also
// the floor under the threshold setting — one number, so a threshold the user
// types is the size their conversations actually compact at.
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

/** π's estimate, mirrored: conservative, and the same chars/4 everywhere. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
