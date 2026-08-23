import { MODEL_ALIASES } from '../agent/known-models'
import type { ModelId } from '../agent/port'
import { isLive, isStale } from './freshness'
import type { QuotaSnapshot } from './types'

// A scoped weekly meter and the account's own week run the same seven days, so
// the scoped one sitting higher means that model is eating the week faster than
// everything else together. The relief below is what a node runs instead.

/** Model id to the model that stands in for it while its own meter runs ahead. */
export const RELIEF: Readonly<Record<ModelId, ModelId>> = {
  'anthropic/claude-fable-5': 'anthropic/claude-opus-5'
}

/** π writes a model as "provider/model-id" with an optional ":thinkingLevel". */
function splitThinking(model: string): { id: string; thinking: string } {
  const at = model.indexOf(':')
  return at < 0 ? { id: model, thinking: '' } : { id: model.slice(0, at), thinking: model.slice(at) }
}

function providerOf(id: string): string {
  const at = id.indexOf('/')
  return at < 0 ? id : id.slice(0, at)
}

/**
 * Whether this model's own weekly meter has outrun the account's week.
 * `false` whenever the reading cannot answer it: a stale or absent reading is
 * not evidence of pressure, and the workflow's declared model stands.
 */
export function outrunsTheWeek(
  id: string,
  snapshot: QuotaSnapshot,
  now: number = Date.now()
): boolean {
  const provider = snapshot.providers[providerOf(id)]
  if (provider === undefined || isStale(provider, now)) return false

  const alias = MODEL_ALIASES[id]
  if (alias === undefined) return false

  const week = provider.meters.find((meter) => meter.kind === 'weekly' && isLive(meter, now))
  const scoped = provider.meters.find(
    (meter) =>
      meter.kind === 'weekly_scoped' &&
      meter.label.toUpperCase() === alias.toUpperCase() &&
      isLive(meter, now)
  )
  if (week === undefined || scoped === undefined) return false
  return scoped.usedPercent > week.usedPercent
}

/**
 * The model to actually run, given what the meters say. The thinking level
 * rides across untouched: the workflow asked for that much thought, and only
 * which model does the thinking is in question here.
 */
export function swapModel(
  model: string,
  snapshot: QuotaSnapshot,
  now: number = Date.now()
): string {
  const { id, thinking } = splitThinking(model)
  const relief = RELIEF[id]
  if (relief === undefined || !outrunsTheWeek(id, snapshot, now)) return model
  return `${relief}${thinking}`
}
