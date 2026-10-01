import type { ModelId, ThinkingLevel } from '../agent/port'

// How a node's model is written and what a node runs when its workflow writes
// none. Shared because the engine runs these and the workflow catalog names
// them, and one string read in two places is one string that can drift.

/** What a node runs when neither its spec nor its plan entry names a model. */
export const ENGINE_DEFAULT_MODEL = 'anthropic/claude-opus-5-5:high'

/** The effort a node runs at when its model names no level. */
export const NODE_DEFAULT_EFFORT: ThinkingLevel = 'medium'

/** `provider/model-id:level`, split into its two halves. */
export interface NodeModel {
  readonly model: ModelId
  readonly effort: ThinkingLevel
  /** Whether the level was written, rather than the default taken. */
  readonly effortStated: boolean
}

const NODE_MODEL = /^([^/\s:]+)\/([^\s:]+?)(?::([a-z]+))?$/

/** The two halves of a node model, or nothing for text that is not one. */
export function parseNodeModel(spec: string): NodeModel | undefined {
  const match = NODE_MODEL.exec(spec.trim())
  if (match === null) return undefined
  const level = match[3]
  return {
    model: `${match[1]}/${match[2]}`,
    effort: level ?? NODE_DEFAULT_EFFORT,
    effortStated: level !== undefined
  }
}
