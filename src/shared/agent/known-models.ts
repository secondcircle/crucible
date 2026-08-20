import type { ModelId } from './port'

// Imports the port's types and nothing else, so no π SDK type can reach the
// renderer through here. A new model means a new build, which is rare enough.

/** An id with no entry here shows whatever the port called it. */
export const MODEL_ALIASES: Readonly<Record<ModelId, string>> = {
  'anthropic/claude-opus-5': 'Opus',
  'anthropic/claude-fable-5': 'Fable'
}

export const MODEL_RING: readonly ModelId[] = [
  'anthropic/claude-opus-5',
  'anthropic/claude-fable-5'
]

export const TITLE_MODEL: ModelId = 'anthropic/claude-haiku-4-5'
