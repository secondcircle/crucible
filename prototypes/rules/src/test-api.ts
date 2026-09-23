// `crucible:rule/test`: what a rule's companion test file writes against.
// Builders return thunks so a test file names no repo; the runner supplies it.

import * as ev from './events.ts'
import type { Action, EditEvent } from './rule.ts'
import { commentBlocks } from './extract.ts'
import { show } from './git.ts'

export type EventSource = (src: ev.Source) => EditEvent[] | Promise<EditEvent[]>

export interface ItemExpect {
  line?: number
  /** Substrings the JSON state must contain. */
  stateIncludes?: string[]
}

export interface Expect {
  /** A count, or one matcher per expected item, in order. Checked without the judge. */
  items?: number | ItemExpect[]
  outOfScope?: true
  /** Needs the judge. `line` picks the item; absent means every item. */
  actions?: { line?: number; is: Action }[]
  /** Needs the judge: the exact text the agent would read, for the first non-pass item. */
  feedback?: string
  /** Needs the judge: a substring of that feedback, when the exact text would pin a line number. */
  feedbackIncludes?: string
}

export interface Scenario {
  name: string
  source: EventSource
  expect: Expect
}

export const registry: Scenario[] = []

export function scenario(name: string, source: EventSource, expect: Expect): void {
  registry.push({ name, source, expect })
}

export const edit =
  (path: string, change: { replace: [string, string] }, at?: string): EventSource =>
  (src) => [ev.edit(src, path, change, at)]

export const write =
  (path: string, text: string, at?: string): EventSource =>
  (src) => [ev.write(src, path, text, at)]

export const commit =
  (sha: string): EventSource =>
  (src) => ev.commit(src, sha)

export const range =
  (base: string, head: string): EventSource =>
  (src) => ev.range(src, base, head)

/**
 * A comment that exists in history, replayed as if an agent had just added it: the file at
 * `at` is `after`, and the same file without that comment is `before`. This is how a test
 * pins a real case, such as one the comment police removed.
 */
export const existingComment =
  (path: string, line: number, at: string): EventSource =>
  async (src) => {
    const text = show(src.repo, at, path)
    if (text === null) throw new Error(`existingComment: ${path} not found at ${at}`)
    const block = (await commentBlocks(path, text)).find((b) => b.start <= line - 1 && line - 1 <= b.end)
    if (!block) throw new Error(`existingComment: no comment at ${at}:${path}:${line}`)
    const lines = text.split('\n')
    lines.splice(block.start, block.end - block.start + 1)
    return [{ path, before: lines.join('\n'), after: text, origin: `comment ${at}:${path}:${line}` }]
  }
