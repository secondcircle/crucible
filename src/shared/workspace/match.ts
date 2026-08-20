import { FILE_RESULT_LIMIT } from './service'

// One matcher for both workspace-service implementations, so the fake ranks a
// list exactly as the real one ranks a folder and a test can pin the order
// once.

/** Case-insensitive: every character of the query, in order, somewhere in the path. */
export function subsequence(path: string, query: string): boolean {
  const haystack = path.toLowerCase()
  let at = 0
  for (const character of query.toLowerCase()) {
    at = haystack.indexOf(character, at)
    if (at === -1) return false
    at += 1
  }
  return true
}

// Three tiers, best first: the filename says it, the path says it, the
// characters are merely all there in order.
function tier(path: string, query: string): number {
  const wanted = query.toLowerCase()
  const lower = path.toLowerCase()
  const file = lower.slice(lower.lastIndexOf('/') + 1)
  if (file.includes(wanted)) return 0
  if (lower.includes(wanted)) return 1
  return 2
}

/**
 * The paths a query matches, best first and then alphabetically, capped. An
 * empty query matches everything. The order is total and deterministic: two
 * calls with the same folder answer identically.
 */
export function rankFiles(paths: readonly string[], query: string): readonly string[] {
  const wanted = query.trim()
  const matched =
    wanted === '' ? [...paths] : paths.filter((path) => subsequence(path, wanted))

  return matched
    .map((path) => ({ path, tier: wanted === '' ? 0 : tier(path, wanted) }))
    .sort((left, right) =>
      left.tier === right.tier ? left.path.localeCompare(right.path) : left.tier - right.tier
    )
    .slice(0, FILE_RESULT_LIMIT)
    .map((ranked) => ranked.path)
}
