// Event builders: read the repo, never write to it.

import type { EditEvent } from './rule.ts'
import { changedFiles, show } from './git.ts'

export interface Source {
  repo: string
}

/** An in-memory edit to a file as it stands at `at` (HEAD by default). */
export function edit(src: Source, path: string, change: { replace: [string, string] }, at = 'HEAD'): EditEvent {
  const before = show(src.repo, at, path)
  if (before === null) throw new Error(`edit: ${path} does not exist at ${at}`)
  const [from, to] = change.replace
  const first = before.indexOf(from)
  if (first === -1) throw new Error(`edit: text to replace not found in ${at}:${path}`)
  if (before.indexOf(from, first + 1) !== -1) throw new Error(`edit: text to replace is not unique in ${at}:${path}`)
  return { path, before, after: before.replace(from, to), origin: `edit ${at}:${path}` }
}

/** A whole-file write; `before` is the file at `at`, or null if it doesn't exist there. */
export function write(src: Source, path: string, text: string, at = 'HEAD'): EditEvent {
  return { path, before: show(src.repo, at, path), after: text, origin: `write ${at}:${path}` }
}

/** A past commit replayed as if an agent had just made it: one event per file. */
export function commit(src: Source, sha: string): EditEvent[] {
  return range(src, `${sha}^`, sha, `commit ${sha.slice(0, 9)}`)
}

/** Any commit range as one agent's work. */
export function range(src: Source, base: string, head: string, origin = `range ${base}..${head}`): EditEvent[] {
  return changedFiles(src.repo, base, head)
    .filter((c) => c.status !== 'D')
    .map((c) => ({
      path: c.path,
      before: c.status === 'A' ? null : show(src.repo, base, c.path),
      after: show(src.repo, head, c.path) ?? '',
      origin,
    }))
}
