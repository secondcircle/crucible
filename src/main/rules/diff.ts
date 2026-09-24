// A change between two texts as one hunk: the lines both share at the top and
// bottom are trimmed away, and what is left between them is the change. An
// agent's edit is almost always one contiguous replacement, and this is the
// shape a person reads it in.

export interface Hunk {
  /** 0-based line where the change starts, in both texts. */
  readonly start: number
  readonly removed: readonly string[]
  readonly added: readonly string[]
}

export function hunkOf(before: string | null, after: string | null): Hunk {
  const old = before === null || before === '' ? [] : before.split('\n')
  const now = after === null || after === '' ? [] : after.split('\n')
  let start = 0
  while (start < old.length && start < now.length && old[start] === now[start]) start++
  let endOld = old.length
  let endNow = now.length
  while (endOld > start && endNow > start && old[endOld - 1] === now[endNow - 1]) {
    endOld--
    endNow--
  }
  return { start, removed: old.slice(start, endOld), added: now.slice(start, endNow) }
}

/** `- ` and `+ ` lines with a line of context either side, as the board shows a change. */
export function lineDiff(before: string | null, after: string | null, context = 1): string {
  const hunk = hunkOf(before, after)
  if (hunk.removed.length === 0 && hunk.added.length === 0) return ''
  const now = after === null ? [] : after.split('\n')
  const old = before === null ? [] : before.split('\n')
  const lead = old.slice(Math.max(0, hunk.start - context), hunk.start)
  const trailFrom = hunk.start + hunk.added.length
  // A file's final newline splits into one empty last line, which is no context.
  const trail = now.slice(trailFrom, trailFrom + context).filter((line, i) => line !== '' || trailFrom + i < now.length - 1)
  return [
    ...lead.map((line) => `  ${line}`),
    ...hunk.removed.map((line) => `- ${line}`),
    ...hunk.added.map((line) => `+ ${line}`),
    ...trail.map((line) => `  ${line}`)
  ].join('\n')
}
