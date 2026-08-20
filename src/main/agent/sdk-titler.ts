import type { TranscriptItem } from '../../shared/agent/port'

// No SDK type reaches this module, so the shaping and sanitizing stay testable
// without constructing an SDK adapter.

/** A model call, so no role prompt composes this. */
export const TITLE_INSTRUCTION =
  'You name conversations. Given a conversation between a user and a coding ' +
  'agent, answer with a 5-8 word description of what the conversation is ' +
  'about. Plain text, no quotes, no trailing period, nothing else.'

/** Past this a message says nothing more about what the session is about. */
const MESSAGE_LIMIT = 500

/** About this much input is plenty to name a conversation by. */
const INPUT_LIMIT = 4_000

// Never tool output, thinking, summaries or bash runs: what the two speakers
// said is what a session is about.
//
// `asked` is a prompt sent but not yet in the conversation the caller holds.
// Without it the first title of a session would have nothing to read, and
// every later one would name the session by the message before the newest.
export function titleInput(
  items: readonly TranscriptItem[],
  asked?: string
): string | undefined {
  const lines: string[] = []
  for (const item of items) {
    if (item.kind === 'user') lines.push(`user: ${clip(item.text)}`)
    else if (item.kind === 'assistant') lines.push(`assistant: ${clip(item.markdown)}`)
  }
  // The conversation may have caught up with it in the meantime, and the same
  // message twice says no more than once.
  const pending = asked === undefined ? undefined : `user: ${clip(asked)}`
  if (pending !== undefined && !lines.includes(pending)) lines.push(pending)
  // The newest messages say most about what a session is about now, so the
  // oldest are the ones dropped when the whole is too long.
  while (lines.length > 1 && joined(lines).length > INPUT_LIMIT) lines.shift()
  if (lines.length === 0) return undefined
  const input = joined(lines)
  return input.trim() === '' ? undefined : input
}

// Absent when nothing survives the trimming, which the caller treats as a
// failed pass.
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
