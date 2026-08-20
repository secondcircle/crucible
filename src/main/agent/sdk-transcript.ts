import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { BashRunShare, ImageAttachment, TranscriptItem } from '../../shared/agent/port'
// Spelled with its extension so this module can also be loaded by plain Node.
import { displaySafeMessage } from './adapter-error.ts'
import { renderToolOutput, summarizeToolArgs } from './sdk-events.ts'

// Stored messages produce the same item kinds a live turn does, so history
// renders through the code a stream renders through.
export type StoredMessage = AgentSession['messages'][number]

// The wire format this adapter owns for a bash run the user added to the
// conversation. It is written by `shareBashRun` and read back here, so a
// restored transcript shows the run as a run rather than as prose.
export const BASH_RUN_TYPE = 'crucible.bashRun'

export function toTranscript(messages: readonly StoredMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  const calls = new Map<string, { name: string; summary: string }>()

  for (const message of messages) {
    if (message.role === 'user') {
      const text = userTextOf(message.content)
      const images = imagesOf(message.content)
      if (text !== '' || images !== undefined) {
        items.push({
          kind: 'user',
          text,
          ...(images === undefined ? {} : { images })
        })
      }
      continue
    }

    // A run Crucible shared, or one π's own `!` grammar recorded: either way
    // it is in the conversation, and only what the model can see is shown.
    if (message.role === 'custom' && message.customType === BASH_RUN_TYPE) {
      const run = bashRunOf(message.details)
      if (run !== undefined) items.push({ kind: 'bashRun', ...run })
      continue
    }

    if (message.role === 'bashExecution') {
      if (message.excludeFromContext === true) continue
      items.push({
        kind: 'bashRun',
        command: message.command,
        output: message.output,
        ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode })
      })
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

/** A run as this adapter wrote it, or nothing when the details are not one. */
export function bashRunOf(details: unknown): BashRunShare | undefined {
  if (typeof details !== 'object' || details === null) return undefined
  const { command, output, exitCode } = details as {
    command?: unknown
    output?: unknown
    exitCode?: unknown
  }
  if (typeof command !== 'string' || typeof output !== 'string') return undefined
  return { command, output, ...(typeof exitCode === 'number' ? { exitCode } : {}) }
}

export function userTextOf(content: unknown): string {
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

// Only images that were genuinely sent with the message: base64 bytes and a
// media type are the whole of what a thumbnail can be rebuilt from.
export function imagesOf(content: unknown): readonly ImageAttachment[] | undefined {
  if (!Array.isArray(content)) return undefined
  const images: ImageAttachment[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const { type, mimeType, data } = block as {
      type?: unknown
      mimeType?: unknown
      data?: unknown
    }
    if (type !== 'image' || typeof mimeType !== 'string' || typeof data !== 'string') continue
    images.push({ mimeType, data })
  }
  return images.length === 0 ? undefined : images
}
