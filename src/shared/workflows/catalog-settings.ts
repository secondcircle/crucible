import type { ModelId, ThinkingLevel } from '../agent/port'

// The workflow catalog's one setting: which model reads the workflow files,
// and at what effort. Shared rather than kept in main, because the Settings
// section edits it and the catalog reads with it.

export interface CatalogReaderSettings {
  readonly model: ModelId
  readonly effort: ThinkingLevel
}

// A reading is a summary and a handful of line numbers, which a mid-sized
// model does well; the largest one would cost several times as much for every
// file saved.
export const DEFAULT_CATALOG_READER: CatalogReaderSettings = {
  model: 'anthropic/claude-sonnet-5-5',
  effort: 'medium'
}

/** The same setting, as one string: what a reading's cache key and its label carry. */
export function readerKey(settings: CatalogReaderSettings): string {
  return `${settings.model}:${settings.effort}`
}

export function sameReader(left: CatalogReaderSettings, right: CatalogReaderSettings): boolean {
  return readerKey(left) === readerKey(right)
}

// Every road in — a stored file written by an older build, a renderer that
// sent something odd — lands here, so nothing downstream has to wonder
// whether the model is a name it can ask for.
export function readCatalogReaderSettings(value: unknown): CatalogReaderSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_CATALOG_READER
  const given = value as { model?: unknown; effort?: unknown }
  const model =
    typeof given.model === 'string' && /^[^/\s]+\/\S+$/.test(given.model.trim())
      ? given.model.trim()
      : DEFAULT_CATALOG_READER.model
  const effort =
    typeof given.effort === 'string' && /^[a-z]+$/.test(given.effort)
      ? given.effort
      : DEFAULT_CATALOG_READER.effort
  return { model, effort }
}
