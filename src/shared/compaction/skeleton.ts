import type { TranscriptItem } from '../agent/port'
import { estimateTokens } from './window.ts'

// The skeleton: the compacted span with its bulk removed. What the two
// speakers said stays verbatim; thinking goes; every tool call becomes one
// line naming the handle it can be re-run from and the size of the result
// that was dropped.
//
// Lines are kept as data rather than as text so a later compaction can strike
// them by number and a budget can count them, and they are rendered the same
// way every time so the numbering the model reads in the window is the
// numbering it strikes against.

export type SkeletonLine =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'assistant'; readonly text: string }
  | {
      readonly kind: 'call'
      readonly name: string
      /** The path, command or query the call can be re-read or re-run from. */
      readonly handle: string
      readonly ok: boolean
      /** What the dropped result was worth, so its size is still on the record. */
      readonly tokens: number
    }
  | { readonly kind: 'bashRun'; readonly command: string; readonly tokens: number }
  | { readonly kind: 'error'; readonly message: string }

/** Past this a line is a paragraph; the whole of it is still on disk. */
const LINE_LIMIT = 600

// Everything that survives a compaction, in order. A summary in the span is a
// previous compaction's own text and never enters the skeleton: summaries are
// rewritten whole, never stacked. A cache seam and a stop marker are the
// transcript's furniture and say nothing to the model.
export function skeletonOf(items: readonly TranscriptItem[]): readonly SkeletonLine[] {
  const lines: SkeletonLine[] = []
  for (const item of items) {
    switch (item.kind) {
      case 'user': {
        const text = clip(item.text)
        if (text !== '') lines.push({ kind: 'user', text })
        break
      }
      case 'assistant': {
        const text = clip(item.markdown)
        if (text !== '') lines.push({ kind: 'assistant', text })
        break
      }
      case 'tool':
        lines.push({
          kind: 'call',
          name: item.name,
          handle: clipHandle(item.summary),
          ok: item.ok,
          tokens: estimateTokens(item.output)
        })
        break
      case 'bashRun':
        lines.push({
          kind: 'bashRun',
          command: clipHandle(item.command),
          tokens: estimateTokens(item.output)
        })
        break
      case 'error':
        lines.push({ kind: 'error', message: clip(item.message) })
        break
      case 'thinking':
      case 'summary':
      case 'cacheMiss':
      case 'stopped':
        break
    }
  }
  return lines
}

/** One line as the model reads it, without its number. */
export function skeletonLineText(line: SkeletonLine): string {
  switch (line.kind) {
    case 'user':
      return `[user] ${line.text}`
    case 'assistant':
      return `[agent] ${line.text}`
    case 'call':
      return `[${line.name}] ${line.handle} → ${line.ok ? 'ok' : 'failed'} · ${count(
        line.tokens
      )} tok dropped`
    case 'bashRun':
      return `[bash run] ${line.command} → ${count(line.tokens)} tok dropped`
    case 'error':
      return `[error] ${line.message}`
  }
}

// Numbered, because the number is how the model strikes a line at the next
// compaction. `startAt` continues an earlier block's numbering, so newly aged
// lines can be offered on their own beside a skeleton the model is already
// reading in its window.
export function renderSkeleton(lines: readonly SkeletonLine[], startAt = 1): string {
  return lines.map((line, index) => `${startAt + index}. ${skeletonLineText(line)}`).join('\n')
}

export function skeletonTokens(lines: readonly SkeletonLine[]): number {
  return lines.reduce((sum, line) => sum + estimateTokens(skeletonLineText(line)) + 4, 0)
}

/** Struck by 1-based number, which is what the model names them by. */
export function pruneSkeleton(
  lines: readonly SkeletonLine[],
  strike: Iterable<number>
): readonly SkeletonLine[] {
  const dead = new Set(strike)
  return lines.filter((_line, index) => !dead.has(index + 1))
}

// The mechanical last word on size, run after the model has pruned. It drops
// the oldest lines that are not somebody's words, because age is as good a
// judge of a tool call as anything and the handle it drops is still on disk.
// It never drops a user message: only the model, naming it, may do that. A
// skeleton of nothing but user messages therefore stays over budget, which is
// the right way round.
export function trimSkeleton(
  lines: readonly SkeletonLine[],
  budget: number
): readonly SkeletonLine[] {
  const kept = [...lines]
  let total = skeletonTokens(kept)
  for (let index = 0; index < kept.length && total > budget; index += 1) {
    const line = kept[index]
    if (line === undefined || line.kind === 'user') continue
    total -= estimateTokens(skeletonLineText(line)) + 4
    kept.splice(index, 1)
    index -= 1
  }
  return kept
}

function count(tokens: number): string {
  return tokens.toLocaleString('en-US')
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= LINE_LIMIT ? line : `${line.slice(0, LINE_LIMIT)}…`
}

// A handle is only useful whole: a truncated path re-reads nothing. Long
// commands are the one exception, and their first line is what identifies
// them.
function clipHandle(handle: string): string {
  const first = handle.split('\n')[0]?.trim() ?? ''
  return first.length <= LINE_LIMIT ? first : `${first.slice(0, LINE_LIMIT)}…`
}
