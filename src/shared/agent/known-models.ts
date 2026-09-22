import type { ModelId } from './port'

// Imports the port's types and nothing else, so no π SDK type can reach the
// renderer through here. A new model means a new build, which is rare enough.

/** An id with no entry here shows whatever the port called it. */
export const MODEL_ALIASES: Readonly<Record<ModelId, string>> = {
  // Both Opuses wear one alias too, for the same reason as the Fables below.
  'anthropic/claude-opus-5': 'Opus',
  'anthropic/claude-opus-5-5': 'Opus',
  // Both Fables wear the same alias: the chip name doubles as the match for
  // the provider's scoped weekly meter, which is labelled per family.
  'anthropic/claude-fable-5': 'Fable',
  'anthropic/claude-fable-5-1': 'Fable'
}

// Opus 5.5 is not in the SDK's built-in catalog until the π release after
// 0.87.0; it reaches the runtime through the pi.dev overlay the adapter
// refreshes, and the ring skips it until then.
export const MODEL_RING: readonly ModelId[] = [
  'anthropic/claude-opus-5-5',
  'anthropic/claude-fable-5-1'
]

export const TITLE_MODEL: ModelId = 'anthropic/claude-haiku-4-5'
