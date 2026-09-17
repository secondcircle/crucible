import { SMALLEST_WORTH_COMPACTING } from './window.ts'

// The one machine-global setting compaction has: whether it runs on its own,
// and the context size it runs at. Shared rather than kept in main, because
// the Settings section edits it and the shell decides with it, and one number
// read two ways is one number that can drift.

/** The switch and the threshold, and nothing else is settable. */
export interface CompactionSettings {
  readonly enabled: boolean
  // Thousands of tokens: the field is labelled in k and `200` means 200,000.
  // Kept in the unit the user types so nothing has to remember which side of
  // the port multiplied.
  readonly thresholdK: number
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  thresholdK: 200
}

// The smallest size a compaction does anything at, in the unit the field is
// typed in. Below it nothing compacts however low the number goes, so a lower
// minimum would be a field that accepts a number it does not honor.
export const MIN_THRESHOLD_K = SMALLEST_WORTH_COMPACTING / 1_000

/** Past any model's window, so anything above it is the same as off. */
export const MAX_THRESHOLD_K = 10_000

export function thresholdTokens(settings: CompactionSettings): number {
  return settings.thresholdK * 1_000
}

// Every road in — a stored file written by an older build, a number typed
// into the field, a renderer that sent something odd — lands here, so no
// caller downstream has to wonder whether the threshold is a usable number.
export function readCompactionSettings(value: unknown): CompactionSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_COMPACTION_SETTINGS
  const given = value as { enabled?: unknown; thresholdK?: unknown }
  return {
    enabled: given.enabled !== false,
    thresholdK: clampThresholdK(given.thresholdK)
  }
}

function clampThresholdK(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_COMPACTION_SETTINGS.thresholdK
  }
  return Math.min(MAX_THRESHOLD_K, Math.max(MIN_THRESHOLD_K, Math.round(value)))
}
