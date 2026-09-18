import type { TranscriptItem } from '../agent/port'
import { spokenByCrucible } from '../agent/spoken-by-crucible.ts'
import { estimateTokens } from './window.ts'

// The skeleton: the compacted span with its bulk removed. What the person
// said stays verbatim; the agent's own replies keep their opening; thinking
// goes; every tool call becomes one line naming the handle it can be re-run
// from and the size of the result that was dropped; every message Crucible
// sent on its own behalf becomes one line naming what it announced.
//
// Lines are kept as data rather than as text so a later compaction can strike
// them by number and a budget can count them, and they are rendered the same
// way every time so the numbering the model reads in the window is the
// numbering it strikes against.

export type SkeletonLine =
  | { readonly kind: 'user'; readonly text: string }
  | {
      readonly kind: 'assistant'
      readonly text: string
      // What the reply said past its opening, counted, so the line still says
      // there was more. Absent when the opening was the whole reply — and on
      // every line a build before this one wrote, which kept replies whole.
      readonly more?: number
    }
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
  // A message Crucible delivered in the user's role: a run's report, a
  // monitor's wake, an answer batch. Its first line names what it announced;
  // the rest lives on the run's record or the question's, and was written for
  // the moment it landed.
  | { readonly kind: 'notice'; readonly text: string; readonly tokens: number }
  | { readonly kind: 'error'; readonly message: string }

// A handle has to stay short enough to be one line of a list. What the person
// said is not cut: it is kept whole, however long it ran.
const HANDLE_LIMIT = 600

// Everything that survives a compaction, in order. A summary in the span is a
// previous compaction's own text and never enters the skeleton: summaries are
// rewritten whole, never stacked. A cache seam and a stop marker are the
// transcript's furniture and say nothing to the model.
export function skeletonOf(items: readonly TranscriptItem[]): readonly SkeletonLine[] {
  const lines: SkeletonLine[] = []
  for (const item of items) {
    switch (item.kind) {
      case 'user': {
        const text = item.text.trim()
        if (text === '') break
        // Crucible's own messages arrive in the user's role because prompting
        // the agent is the only voice a run or a monitor has, but nobody typed
        // them and every fact in one is on a record somewhere else. Kept
        // whole, four re-asked checkpoints and two completion reports are
        // most of a skeleton, all of it protected by a rule written for the
        // person's brief. One line, like a tool call: what it announced, and
        // what the rest weighed.
        if (spokenByCrucible(text)) {
          lines.push({ kind: 'notice', text: clipHandle(text), tokens: estimateTokens(text) })
          break
        }
        // Verbatim, whatever the length. What the person said is the one
        // thing a compaction cannot get back: a file can be re-read and a
        // command re-run, but a brief the user typed in the first minute lives
        // only in the session file and the transcript, neither of which the
        // model can reach afterwards. The budget below and the model's own
        // strike list are what hold the size down; a cut here would be a size
        // policy nobody could see, applied before anything was asked.
        lines.push({ kind: 'user', text })
        break
      }
      case 'assistant': {
        const text = item.markdown.trim()
        if (text !== '') lines.push(assistantLine(text))
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
        // Not speech: a failure's first line is what names it, and a stack
        // behind it says nothing the agent can act on later.
        lines.push({ kind: 'error', message: clipHandle(item.message) })
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

// The agent's reply keeps its opening paragraph and no more. A reply opens
// with what is waiting on the person and closes with the account of the work,
// and the account is what the trajectory summary is rewritten from at the
// same compaction: kept whole as well, every reply restates the summary
// beside it. What was cut is counted so the line admits there was more.
function assistantLine(text: string): SkeletonLine {
  const opening = clipHandle(firstParagraph(text))
  const more = estimateTokens(text) - estimateTokens(opening)
  return more > 0 ? { kind: 'assistant', text: opening, more } : { kind: 'assistant', text: opening }
}

function firstParagraph(text: string): string {
  return text.split(/\n\s*\n/)[0] ?? ''
}

/** One line as the model reads it, without its number. */
export function skeletonLineText(line: SkeletonLine): string {
  switch (line.kind) {
    case 'user':
      return `[user] ${line.text}`
    case 'assistant':
      return line.more === undefined
        ? `[agent] ${line.text}`
        : `[agent] ${line.text} · ${count(line.more)} more tok`
    case 'call':
      return `[${line.name}] ${line.handle} → ${line.ok ? 'ok' : 'failed'} · ${count(
        line.tokens
      )} tok dropped`
    case 'bashRun':
      return `[bash run] ${line.command} → ${count(line.tokens)} tok dropped`
    case 'notice':
      return `[crucible] ${line.text} · ${count(line.tokens)} tok dropped`
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
// the oldest lines that are not the person's words, because age is as good a
// judge of anything else here as the model is: a handle it drops is still on
// disk, a notice is still on its record, and a reply's opening was restated
// in the summary. It never drops a user message: only the model, naming it,
// may do that. A skeleton of nothing but user messages therefore stays over
// budget, which is the right way round.
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

// A handle is only useful whole: a truncated path re-reads nothing. Long
// commands are the one exception, and their first line is what identifies
// them.
function clipHandle(handle: string): string {
  const first = handle.split('\n')[0]?.trim() ?? ''
  return first.length <= HANDLE_LIMIT ? first : `${first.slice(0, HANDLE_LIMIT)}…`
}
