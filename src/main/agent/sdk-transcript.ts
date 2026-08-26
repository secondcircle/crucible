import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type {
  BashRunShare,
  CacheMissFacts,
  ImageAttachment,
  TranscriptItem
} from '../../shared/agent/port'
// Spelled with its extension so this module can also be loaded by plain Node.
import { displaySafeMessage } from './adapter-error.ts'
import {
  scanCacheMisses,
  type CacheMessage,
  type CacheMissTrackerOptions,
  type CacheScanEntry,
  type DetectedCacheMiss
} from './cache-miss.ts'
import { renderToolOutput, summarizeToolArgs } from './sdk-events.ts'
import { stripTurnContext } from './turn-context.ts'

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

// π's own shapes read as the mirror reads them. The sequence below stays
// index-aligned with what it was built from, so a miss can be put back beside
// the message that paid for it.

/** One entry of a π session file, as much of it as the mirror needs. */
interface StoredEntry {
  readonly type?: unknown
  readonly message?: unknown
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

// Where a conversation's misses land on the path it is currently showing,
// keyed by the path message that paid for each one.
//
// The scan is over every entry, never over the path alone, because that is
// what π does on resume and what live detection here does: the request a
// message is compared against is the one that was really billed before it,
// which after a jump is not the message above it on the path. Scanning the
// path instead would answer one conversation's question two ways — a seam
// live and in the ledger, none on reopen — with the badge still counting it.
// Each miss then goes back beside its own message, by identity: π hands the
// same message object to the entry and to the agent's state, so a path
// message and its entry are the same object. π does copy the one shape it
// repairs on load — a message stored with null content — and a copy is a
// different object, so the message's own usage object is keyed as well: the
// copy is shallow and carries the same one, and a miss exists only for a
// message that has usage.
export function pathSeams(
  entries: readonly unknown[],
  messages: readonly StoredMessage[],
  options?: CacheMissTrackerOptions
): Map<number, DetectedCacheMiss> {
  const scan = scanCacheMisses(entriesToScan(entries), options)
  if (scan.misses.length === 0) return new Map()

  const paid = new Map<unknown, DetectedCacheMiss>()
  for (const { at, miss } of scan.misses) {
    const message = ((entries[at] ?? {}) as StoredEntry).message
    if (message === undefined) continue
    paid.set(message, miss)
    const { usage } = message as { usage?: unknown }
    if (typeof usage === 'object' && usage !== null) paid.set(usage, miss)
  }

  const seams = new Map<number, DetectedCacheMiss>()
  messages.forEach((message, index) => {
    const miss = paid.get(message) ?? paid.get((message as { usage?: unknown }).usage)
    if (miss !== undefined) seams.set(index, miss)
  })
  return seams
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

// Turn-start context rides inside the user message π stored, and no surface
// may show it: stripping it here covers the transcript, the session tree and
// the titler, all three of which read a user message through this.
export function userTextOf(content: unknown): string {
  if (typeof content === 'string') return stripTurnContext(content).trim()
  if (!Array.isArray(content)) return ''
  const joined = content
    .map((block) =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''
    )
    .join('')
  return stripTurnContext(joined).trim()
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
