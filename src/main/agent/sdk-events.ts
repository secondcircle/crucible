import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { AdapterEvent } from '../../shared/agent/adapter'
import type { SessionId, TurnId } from '../../shared/agent/port'
// Spelled with its extension for the same reason `sdk-adapter.ts` spells this
// module's: `npm run prove:sdk` loads the tree under plain Node.
import { displaySafeMessage } from './adapter-error.ts'

/**
 * The π SDK's event union, reduced to the events the adapter contract speaks.
 *
 * This is the enforcement point for "no π SDK type crosses the port": it takes
 * the SDK's `AgentSessionEvent` and returns a plain, cloneable `AdapterEvent` —
 * or nothing at all, which is how everything outside the table below leaves the
 * system. The SDK is imported for its types only, so this module is pure
 * translation with nothing behind it: no session, no credentials, no network.
 * That is what lets it be unit tested while `npm test` still constructs no SDK
 * adapter (SA-8).
 *
 * The mapping, and nothing else:
 *
 * | SDK event                                              | adapter event  |
 * | ------------------------------------------------------ | -------------- |
 * | `message_update` + `assistantMessageEvent.text_delta`  | `text_delta`   |
 * | `message_update` + `.thinking_delta`                   | `thinking_delta` |
 * | `tool_execution_start`                                 | `tool_started` |
 * | `tool_execution_update`                                | `tool_output`  |
 * | `tool_execution_end`                                   | `tool_ended`   |
 * | `message_update` + `.error`                            | `turn_error`   |
 * | `message_end` with `stopReason: "error"`               | `turn_error`   |
 *
 * The last row is the one this project learned by running the SDK rather than
 * by reading it. `@earendil-works/pi-coding-agent@0.84.2` emits
 * `message_update` only for the streaming *content* variants and folds a failed
 * request into the final message instead, where it arrives as `message_end`
 * with `stopReason: "error"` and an `errorMessage`, followed by `turn_end`,
 * with `prompt()` resolving normally. Without this row a paid request that
 * failed would reach the transcript as a clean end and no text — a silent
 * success.
 *
 * A turn's *shape* is not this module's business. `turn_start` and `turn_end`
 * are dropped, because one `prompt()` call can span several SDK turns — a
 * transient failure the SDK retries, a compaction it runs by itself — and the
 * port's turn is bounded by the call, not by the stream. An abort is dropped
 * for a different reason: whether a turn was cancelled is something only the
 * adapter that called `abort()` knows, and cancelled is its own outcome (A3).
 *
 * Tool output arrives as a growing snapshot rather than as chunks, so the
 * mapper remembers how much of each call's output it has already forwarded and
 * emits only what is new. That is the whole of its state, and the reason it is
 * a small factory rather than a bare function.
 */

/** Which session and turn the events being mapped belong to. */
export interface TurnTarget {
  readonly sessionId: SessionId
  readonly turnId: TurnId
}

export interface EventMapper {
  map(event: AgentSessionEvent, target: TurnTarget): AdapterEvent | undefined
}

/** How much of a tool's output may cross the seam, per call. */
const OUTPUT_LIMIT = 20_000

/** How long an argument summary may be before it stops being a summary. */
const SUMMARY_LIMIT = 160

export function createEventMapper(): EventMapper {
  /** Characters of each call's output already forwarded, by tool call id. */
  const forwarded = new Map<string, number>()

  return {
    map(event: AgentSessionEvent, { sessionId, turnId }: TurnTarget): AdapterEvent | undefined {
      switch (event.type) {
        case 'message_update':
          switch (event.assistantMessageEvent.type) {
            case 'text_delta':
              return {
                type: 'text_delta',
                sessionId,
                turnId,
                delta: event.assistantMessageEvent.delta
              }
            case 'thinking_delta':
              return {
                type: 'thinking_delta',
                sessionId,
                turnId,
                delta: event.assistantMessageEvent.delta
              }
            case 'error':
              // An abort is not a failure: the adapter that asked for it says
              // so itself, and says it once.
              return event.assistantMessageEvent.reason === 'aborted'
                ? undefined
                : {
                    type: 'turn_error',
                    sessionId,
                    turnId,
                    message: displaySafeMessage(
                      event.assistantMessageEvent.error.errorMessage
                    )
                  }
            default:
              return undefined
          }

        case 'message_end':
          return event.message.role === 'assistant' && event.message.stopReason === 'error'
            ? {
                type: 'turn_error',
                sessionId,
                turnId,
                message: displaySafeMessage(event.message.errorMessage)
              }
            : undefined

        case 'tool_execution_start':
          forwarded.set(event.toolCallId, 0)
          return {
            type: 'tool_started',
            sessionId,
            turnId,
            callId: event.toolCallId,
            name: event.toolName,
            summary: summarizeToolArgs(event.args)
          }

        case 'tool_execution_update': {
          const whole = renderToolOutput(event.partialResult)
          const already = forwarded.get(event.toolCallId) ?? 0
          if (whole.length <= already) return undefined
          forwarded.set(event.toolCallId, whole.length)
          return {
            type: 'tool_output',
            sessionId,
            turnId,
            callId: event.toolCallId,
            chunk: whole.slice(already)
          }
        }

        case 'tool_execution_end':
          forwarded.delete(event.toolCallId)
          return {
            type: 'tool_ended',
            sessionId,
            turnId,
            callId: event.toolCallId,
            ok: !event.isError,
            output: renderToolOutput(event.result)
          }

        default:
          return undefined
      }
    }
  }
}

/**
 * What a tool call is doing, in one line: the argument a person recognizes the
 * call by — a command, a path — rather than the whole argument object. It is
 * the chip's label (TL-2), so it is always something short and always text.
 */
export function summarizeToolArgs(args: unknown): string {
  if (typeof args === 'string') return clip(args, SUMMARY_LIMIT)
  if (typeof args !== 'object' || args === null) return ''

  const fields = args as Record<string, unknown>
  for (const key of ['command', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url']) {
    const value = fields[key]
    if (typeof value === 'string' && value.trim() !== '') return clip(value.trim(), SUMMARY_LIMIT)
  }
  const first = Object.values(fields).find((value) => typeof value === 'string' && value !== '')
  return typeof first === 'string' ? clip(first, SUMMARY_LIMIT) : ''
}

/**
 * A tool result as text. Only the text blocks cross: an image or a structured
 * `details` payload is the SDK's own shape and has no business in a transcript
 * item, which is a string.
 */
export function renderToolOutput(result: unknown): string {
  if (typeof result === 'string') return clip(result, OUTPUT_LIMIT)
  if (typeof result !== 'object' || result === null) return ''

  const content = (result as { content?: unknown }).content
  if (typeof content === 'string') return clip(content, OUTPUT_LIMIT)
  if (!Array.isArray(content)) return ''

  const text = content
    .map((block) =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''
    )
    .join('')
  return clip(text, OUTPUT_LIMIT)
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncated)`
}
