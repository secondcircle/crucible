import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { TranscriptItem } from '../../shared/agent/port'
// Spelled with its extension so this module can also be loaded by plain Node.
import { displaySafeMessage } from './adapter-error.ts'
import { renderToolOutput, summarizeToolArgs } from './sdk-events.ts'

// Stored messages produce the same item kinds a live turn does, so history
// renders through the code a stream renders through. Anything the SDK stores
// that is not text is dropped rather than guessed at.
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
        // The SDK does not store how long a thought took, and a number nobody
        // measured is not one to show.
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
