import type { CompactionRecord } from '../../../shared/compaction/record'
import type { CompactionTrigger } from '../../../shared/compaction/record'
import { compactTokens } from '../cache/format'

// What a compaction's block says beside the summary: what fired it and what
// the window went from and to. Facts, in the same compact token spelling the
// cache surfaces use.

export function triggerText(trigger: CompactionTrigger): string {
  switch (trigger) {
    case 'threshold':
      return 'past the threshold'
    // Named for what it is rather than for the setting, because this one
    // fires with the setting off too.
    case 'windowEdge':
      return 'at the model’s window'
    case 'idle':
      return 'idle, cache still warm'
  }
}

export function compactionFacts(record: CompactionRecord): string {
  return `${triggerText(record.trigger)} · ${compactTokens(record.tokensBefore)} → ${compactTokens(
    record.tokensAfter
  )}`
}
