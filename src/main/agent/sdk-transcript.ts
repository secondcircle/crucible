import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type {
  BashRunShare,
  CacheMissFacts,
  ImageAttachment,
  TranscriptItem
} from '../../shared/agent/port'
// Spelled with its extension so this module can also be loaded by plain Node.
import { displaySafeMessage } from './adapter-error.ts'
import type { CacheMessage, CacheScanEntry } from './cache-miss.ts'
import { renderToolOutput, summarizeToolArgs } from './sdk-events.ts'

// Stored messages produce the same item kinds a live turn does, so history
// renders through the code a stream renders through.
export type StoredMessage = AgentSession['messages'][number]

// Written by `shareBashRun` and read back here, so a restored transcript
// shows a shared run as a run rather than as prose.
export const BASH_RUN_TYPE = 'crucible.bashRun'

// A seam per message that paid for a miss, keyed by that message's position
// in `messages`, so a restored conversation shows the miss immediately above
// the assistant message it happened on.
export function toTranscript(
  messages: readonly StoredMessage[],
  seams?: ReadonlyMap<number, CacheMissFacts>
): TranscriptItem[] {
  const items: TranscriptItem[] = []
  const calls = new Map<string, { name: string; summary: string }>()

  for (const [index, message] of messages.entries()) {
    const seam = seams?.get(index)
    if (seam !== undefined) items.push({ kind: 'cacheMiss', miss: seam })
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

    // π writes these when a branch is left with a summary or the context is
    // compacted: the summary IS the context now, so the transcript shows it.
    if (message.role === 'branchSummary' || message.role === 'compactionSummary') {
      items.push({ kind: 'summary', text: message.summary })
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

// π's own shapes read as the mirror reads them. Both sequences below stay
// index-aligned with what they were built from, so a miss can be put back
// beside the message that paid for it.

/** One entry of a π session file, as much of it as the mirror needs. */
interface StoredEntry {
  readonly type?: unknown
  readonly message?: unknown
}

/** The current path's messages: what a transcript is built from. */
export function messagesToScan(messages: readonly StoredMessage[]): CacheScanEntry[] {
  return messages.map((message): CacheScanEntry => {
    // π writes these when a branch is left with a summary or the context is
    // compacted: the next prompt is new content, not re-billed content.
    if (message.role === 'branchSummary' || message.role === 'compactionSummary') {
      return { kind: 'contextReset' }
    }
    const scanned = message.role === 'assistant' ? toCacheMessage(message) : undefined
    return scanned === undefined ? { kind: 'other' } : { kind: 'assistant', message: scanned }
  })
}

// Every entry of the conversation, every branch of it: what the whole-session
// totals are counted over, exactly as the money is.
export function entriesToScan(entries: readonly unknown[]): CacheScanEntry[] {
  return entries.map((raw): CacheScanEntry => {
    const entry = (raw ?? {}) as StoredEntry
    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      return { kind: 'contextReset' }
    }
    if (entry.type !== 'message') return { kind: 'other' }
    const message = entry.message as StoredMessage | undefined
    if (message === undefined || message.role !== 'assistant') return { kind: 'other' }
    const scanned = toCacheMessage(message)
    return scanned === undefined ? { kind: 'other' } : { kind: 'assistant', message: scanned }
  })
}

// An assistant message that carries no usage carries no arithmetic either,
// and nothing is invented for it.
export function toCacheMessage(message: StoredMessage): CacheMessage | undefined {
  const carrier = message as unknown as {
    provider?: unknown
    model?: unknown
    timestamp?: unknown
    usage?: unknown
  }
  if (typeof carrier.usage !== 'object' || carrier.usage === null) return undefined
  return {
    provider: typeof carrier.provider === 'string' ? carrier.provider : '',
    model: typeof carrier.model === 'string' ? carrier.model : '',
    timestamp: typeof carrier.timestamp === 'number' ? carrier.timestamp : 0,
    usage: carrier.usage
  }
}

// `message_end` is the only event π emits for a steered custom message, and
// the moment it persists one, so it is the only observable delivery point.
export function deliveredBashRunId(event: AgentSessionEvent): string | undefined {
  if (event.type !== 'message_end') return undefined
  const { message } = event
  if (message.role !== 'custom' || message.customType !== BASH_RUN_TYPE) return undefined
  const id = (message.details as { id?: unknown } | undefined)?.id
  return typeof id === 'string' ? id : undefined
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
