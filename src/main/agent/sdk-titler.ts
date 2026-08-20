import type { TranscriptItem } from '../../shared/agent/port'

// The titler's shaping and sanitizing, with no SDK type in sight, so `npm test`
// covers both without constructing an SDK adapter. The completion itself lives
// in the adapter; everything decidable without a network lives here.

/** What the titler is asked for. A model call, so no role prompt composes it. */
export const TITLE_INSTRUCTION =
  'You name conversations. Given a conversation between a user and a coding ' +
  'agent, answer with a 5-8 word description of what the conversation is ' +
  'about. Plain text, no quotes, no trailing period, nothing else.'

/** Past this a message says nothing more about what the session is about. */
const MESSAGE_LIMIT = 500

/** About this much input is plenty to name a conversation by. */
const INPUT_LIMIT = 4_000

/**
 * The conversation as the titler sees it: user and assistant messages only,
 * oldest first. Never tool output, thinking, summaries or bash runs. Absent
 * when there is nothing to title.
 */
export function titleInput(items: readonly TranscriptItem[]): string | undefined {
  const lines: string[] = []
  for (const item of items) {
    if (item.kind === 'user') lines.push(`user: ${clip(item.text)}`)
    else if (item.kind === 'assistant') lines.push(`assistant: ${clip(item.markdown)}`)
  }
  // The newest messages say most about what a session is about now, so the
  // oldest are the ones dropped when the whole is too long.
  while (lines.length > 1 && joined(lines).length > INPUT_LIMIT) lines.shift()
  if (lines.length === 0) return undefined
  const input = joined(lines)
  return input.trim() === '' ? undefined : input
}

/**
 * A title out of whatever the model answered: its first line, trimmed, with
 * surrounding quotes stripped and inner whitespace collapsed. Absent when
 * nothing is left, which the caller treats as a failed pass.
 */
export function sanitizeTitle(reply: string): string | undefined {
  const first = reply.split('\n')[0] ?? ''
  const title = first
    .trim()
    .replace(/^["'“”‘’]+/, '')
    .replace(/["'“”‘’]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return title === '' ? undefined : title
}

function joined(lines: readonly string[]): string {
  return lines.join('\n\n')
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= MESSAGE_LIMIT ? line : `${line.slice(0, MESSAGE_LIMIT)}…`
}
