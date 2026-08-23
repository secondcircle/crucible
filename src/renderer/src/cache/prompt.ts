import type { CacheHealth } from '../../../shared/cache/service'
import { retentionSource } from './format'

// What Investigate sends. The app starts the investigation rather than
// telling the user where to look, so this text carries everything an agent
// needs to answer the question by itself: the file, the boundary to count
// from, and the setting the whole experiment exists to measure. It judges
// nothing away, because an idle-expiry miss is the datum that decides the
// retention question.

export function investigationPrompt(health: CacheHealth): string {
  // Spelled out rather than the seam's shorthand: this is read by a model,
  // and "5 min" beside a five-minute TTL is one abbreviation too many.
  const spelled = health.retention === '1h' ? '1 hour' : '5 minutes'
  const retention = `${spelled} (${retentionSource(health.retention, health.retentionSource)})`

  return (
    `Investigate Crucible's cache misses. The ledger of every miss Crucible has ever ` +
    `observed is at \`${health.ledgerPath}\`: JSONL, one line per miss, plus \`reset\` lines ` +
    `marking investigation boundaries. Focus on entries after the last reset ` +
    `(\`${health.since}\`). The retention setting in force is \`${retention}\`. Work out which ` +
    `sessions, runs, models, gaps and changes account for the tokens re-billed, and what ` +
    `change would cut them. Judge nothing away: an idle-expiry miss is evidence, not noise.`
  )
}
