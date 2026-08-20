import type { ModelId } from './port'

// The one place Crucible names a model of its own. It imports the port's types
// and nothing else, so no π SDK type can reach the renderer through it, and it
// is a build-time constant on purpose: a new model means a new build, which is
// rare enough to be fine.
//
// Why no ADR carries this: an alias renames an id Crucible already knows, for
// display only, and the ring is an order over models the agent port reported.
// Neither changes what the picker lists, how it lists it, or what the port is
// asked for. They sit on top of model selection rather than inside it.

/**
 * Display-only. Keys are the ids the SDK adapter mints (`provider/model`); an
 * id with no entry here shows whatever the port called it.
 */
export const MODEL_ALIASES: Readonly<Record<ModelId, string>> = {
  'anthropic/claude-opus-5': 'Opus',
  'anthropic/claude-fable-5': 'Fable'
}

/** The model ring, in cycle order. */
export const MODEL_RING: readonly ModelId[] = [
  'anthropic/claude-opus-5',
  'anthropic/claude-fable-5'
]

/** The session-title writer. */
export const TITLE_MODEL: ModelId = 'anthropic/claude-haiku-4-5'
