import type { TranscriptItem } from '../../shared/agent/port'
import { isRunMessage } from '../../shared/workflows/run'

// No SDK type reaches this module, so the shaping and sanitizing stay testable
// without constructing an SDK adapter.

/** A model call, so no role prompt composes this. */
export const TITLE_INSTRUCTION =
  'You name conversations. Given a conversation between a user and a coding ' +
  'agent, answer with a 5-8 word description of what the conversation is ' +
  'about. Plain text, no quotes, no trailing period, nothing else.'

/** Past this a message says nothing more about what the session is about. */
const MESSAGE_LIMIT = 500

// The instruction asks for 5-8 words. Well past that the model is talking
// rather than naming — "I need more context to name this conversation" must
// read as a failed pass, not become the title.
const TITLE_WORD_LIMIT = 12

/** About this much input is plenty to name a conversation by. */
const INPUT_LIMIT = 4_000

// Never tool output, thinking or bash runs: what the two speakers said is
// what a session is about. Summaries are the one exception — after a
// compaction or a summarized branch jump the summary IS the conversation,
// and without it the titler would read an almost empty session.
//
// A run's messages arrive in the user's role because prompting an agent is
// the only voice a run has (ADR 0017), but nobody typed them and they are
// status, not subject. Left in, they take over the name of any session short
// enough for a few of them to be most of it — the sidebar ends up reading
// "Crucible run fk139 completed" instead of the work the human came for.
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
    if (item.kind === 'user' && isRunMessage(item.text)) continue
    if (item.kind === 'user') lines.push(`user: ${clip(item.text)}`)
    else if (item.kind === 'assistant') lines.push(`assistant: ${clip(item.markdown)}`)
    else if (item.kind === 'summary') lines.push(`summary: ${clip(item.text)}`)
  }
  // The conversation may have caught up with it in the meantime, and the same
  // message twice says no more than once.
  const pending =
    asked === undefined || isRunMessage(asked) ? undefined : `user: ${clip(asked)}`
  if (pending !== undefined && !lines.includes(pending)) lines.push(pending)
  // The newest messages say most about what a session is about now, so the
  // oldest are the ones dropped when the whole is too long.
  while (lines.length > 1 && joined(lines).length > INPUT_LIMIT) lines.shift()
  if (lines.length === 0) return undefined
  const input = joined(lines)
  return input.trim() === '' ? undefined : input
}

// Absent when nothing survives the trimming, or when the answer is too long
// to be a name at all: either way the caller treats it as a failed pass and
// the last good title stays.
export function sanitizeTitle(reply: string): string | undefined {
  const first = reply.split('\n')[0] ?? ''
  const title = first
    .trim()
    .replace(/^["'“”‘’]+/, '')
    .replace(/["'“”‘’]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (title === '') return undefined
  return title.split(' ').length > TITLE_WORD_LIMIT ? undefined : title
}

function joined(lines: readonly string[]): string {
  return lines.join('\n\n')
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= MESSAGE_LIMIT ? line : `${line.slice(0, MESSAGE_LIMIT)}…`
}
