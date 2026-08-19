import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { TranscriptItem } from '../../shared/agent/port'
// Spelled with its extension so this module can also be loaded by plain Node.
import { displaySafeMessage } from './adapter-error.ts'
import { renderToolOutput, summarizeToolArgs } from './sdk-events.ts'

/**
 * A π conversation's messages, rendered as the port's transcript items.
 *
 * This is the other half of the SDK-side translation — `sdk-events.ts` handles
 * a turn as it happens, this handles one that already did — and the two produce
 * the same item kinds on purpose: a restored transcript renders through exactly
 * the code a live one does (TR-7), so history cannot drift into a second
 * appearance of its own.
 *
 * Message order is item order. Inside an assistant message, blocks are walked
 * in order too, so a thinking block that preceded some text still precedes it
 * afterwards, and consecutive text blocks merge into the one markdown item they
 * were always meant to read as.
 *
 * Two message facts become items of their own:
 *
 * - An assistant message the SDK marks `aborted` is a turn somebody stopped, so
 *   it closes with the same quiet stopped marker a live cancellation leaves
 *   (A4). That is what makes "the cancelled turn's partial output is still in
 *   context" visible after a relaunch rather than merely true.
 * - An assistant message marked `error` closes with an error item carrying a
 *   display-safe sentence — the raw `errorMessage` never crosses.
 *
 * Everything else the SDK can store — custom entries, images, tool `details` —
 * is dropped rather than guessed at. A transcript item is text.
 */
export type StoredMessage = AgentSession['messages'][number]

export function toTranscript(messages: readonly StoredMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  /** Tool calls seen in assistant messages, waiting for their results. */
  const calls = new Map<string, { name: string; summary: string }>()

  for (const message of messages) {
    if (message.role === 'user') {
      const text = textOf(message.content)
      if (text !== '') items.push({ kind: 'user', text })
      continue
    }

    if (message.role === 'toolResult') {
      const call = calls.get(message.toolCallId)
      items.push({
        kind: 'tool',
        name: message.toolName,
        summary: call?.summary ?? '',
        ok: !message.isError,
        output: renderToolOutput(message)
      })
      calls.delete(message.toolCallId)
      continue
    }

    if (message.role !== 'assistant') continue

    let markdown = ''
    const flush = (): void => {
      if (markdown.trim() !== '') items.push({ kind: 'assistant', markdown })
      markdown = ''
    }

    for (const block of message.content) {
      if (block.type === 'text') {
        markdown += block.text
        continue
      }
      if (block.type === 'thinking') {
        flush()
        // No duration: the SDK does not store how long a stored thought took,
        // and a number nobody measured is not one to show (A27).
        if (block.thinking.trim() !== '') items.push({ kind: 'thinking', text: block.thinking })
        continue
      }
      if (block.type === 'toolCall') {
        flush()
        calls.set(block.id, { name: block.name, summary: summarizeToolArgs(block.arguments) })
      }
    }
    flush()

    if (message.stopReason === 'aborted') items.push({ kind: 'stopped' })
    else if (message.stopReason === 'error') {
      items.push({
        kind: 'error',
        message: displaySafeMessage(message.errorMessage, 'The turn failed.')
      })
    }
  }

  return items
}

/** A message's text, whichever of the two shapes its content came in. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((block) =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''
    )
    .join('')
    .trim()
}
