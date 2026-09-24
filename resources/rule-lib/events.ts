// Event builders: read the repo, never write to it. The live hooks build the
// same shapes from what an agent just did; these build them from history.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BashEvent, CheckpointEvent, CommitEvent, EditEvent, FileDiff } from './rule.ts'
import { changedFiles, git, show } from './git.ts'

export interface Source {
  readonly repo: string
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

/** A past commit replayed as if an agent had just made it: one edit event per file. */
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

/** A bash call, with its cwd at the repo root. */
export function bash(src: Source, command: string): BashEvent {
  return { command, cwd: src.repo, origin: `bash ${command}` }
}

function diffsOf(src: Source, base: string, head: string | null): FileDiff[] {
  const target = head ?? undefined
  return changedFiles(src.repo, base, target)
    .map((c) => ({
      path: c.path,
      before: c.status === 'A' ? null : show(src.repo, base, c.path),
      after: c.status === 'D' ? null : head === null ? onDisk(src, c.path) : show(src.repo, head, c.path),
    }))
}

function onDisk(src: Source, path: string): string | null {
  try {
    return readFileSync(join(src.repo, path), 'utf8')
  } catch {
    return null
  }
}

/** A commit as a commit rule sees it: its message and every file it touched. */
export function commitEvent(src: Source, sha: string): CommitEvent {
  const message = git(src.repo, ['log', '-1', '--format=%B', sha]).trim()
  return { sha, message, files: diffsOf(src, `${sha}^`, sha), origin: `commit ${sha.slice(0, 9)}` }
}

/**
 * Any range standing in for one node's or one turn's work. With no head, the
 * working tree is the far end, which is what a live checkpoint sees.
 */
export function checkpoint(
  src: Source,
  base: string,
  head: string | null = null,
  at: CheckpointEvent['at'] = 'node-complete'
): CheckpointEvent {
  return { at, base, files: diffsOf(src, base, head), origin: `checkpoint ${base}..${head ?? 'working tree'}` }
}
