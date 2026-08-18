import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { PortEvent, TurnId } from '../../shared/agent/port'
// Spelled with its extension for the same reason `sdk-adapter.ts` spells this
// module's: `npm run prove:sdk` loads the tree under plain Node.
import { adapterError } from './adapter-error.ts'

/**
 * The whole of the π SDK's event union, reduced to the four events the port
 * speaks (D3).
 *
 * This is the enforcement point for "no π SDK type crosses the port": it takes
 * the SDK's `AgentSessionEvent` and a turn id and returns a plain, cloneable
 * `PortEvent` — or nothing at all, which is how everything outside the table
 * below leaves the system. The SDK is imported for its types only, so this
 * module is pure translation with nothing behind it: no session, no
 * credentials, no network. That is what lets it be unit tested while `npm test`
 * still never constructs the SDK adapter (D12).
 *
 * The mapping, and nothing else:
 *
 * | SDK event                                             | Port event   |
 * | ----------------------------------------------------- | ------------ |
 * | `turn_start`                                          | `turn_started` |
 * | `message_update` + `assistantMessageEvent.text_delta` | `text_delta` |
 * | `turn_end`                                            | `turn_ended` |
 * | `message_update` + `assistantMessageEvent.error`      | `error` (`adapter`) |
 * | `message_end` with `stopReason: "error"`              | `error` (`adapter`) |
 *
 * The last row is the one this milestone learned by running the SDK rather
 * than by reading it. `@earendil-works/pi-coding-agent@0.84.2` emits
 * `message_update` only for the streaming *content* variants — text, thinking,
 * tool calls (`pi-agent-core/dist/agent-loop.js:210-227`) — and folds a failed
 * request into the final message instead (`:228`, `case "done": case "error"`),
 * where it arrives as `message_end` with `stopReason: "error"` and an
 * `errorMessage`, followed by `turn_end`, with `prompt()` resolving normally.
 * Without this row a paid request that failed would reach the pane as a clean
 * `turn_ended` and no text — a silent success. The
 * `assistantMessageEvent.error` row stays: it is what the SDK's own types
 * describe, and the two cannot both fire for one turn because the first
 * terminal event closes it.
 *
 * Anything absent from the table is dropped and returns `undefined`: tool events
 * cannot arise at all, because the session runs with tools off (D11), while
 * compaction and retries stay the SDK's own business — a turn that is being
 * retried has not ended and has not failed as far as a caller is concerned, so
 * the port says nothing about it. Thinking, message and agent lifecycle events
 * go the same way.
 *
 * What a failed turn *says* is not this function's job either: the raw text the
 * SDK carries is handed to `adapterError`, which is where the Contracts' rule
 * that `error.message` is display-safe text — no stacks, no SDK error objects,
 * no provider payloads — is kept for both of the directions a turn can fail
 * from.
 *
 * Sequencing is not this function's job. It maps one event at a time and has no
 * memory, so "exactly one `turn_started`, then deltas, then exactly one
 * terminal event" is kept by the adapter that drives it — which is also where a
 * `prompt()` that throws becomes the same `error` this returns for a failed
 * message.
 */
export function toPortEvent(event: AgentSessionEvent, turnId: TurnId): PortEvent | undefined {
  switch (event.type) {
    case 'turn_start':
      return { type: 'turn_started', turnId }

    case 'turn_end':
      return { type: 'turn_ended', turnId }

    case 'message_end':
      return event.message.role === 'assistant' && event.message.stopReason === 'error'
        ? adapterError(turnId, event.message.errorMessage)
        : undefined

    case 'message_update':
      switch (event.assistantMessageEvent.type) {
        case 'text_delta':
          return { type: 'text_delta', turnId, delta: event.assistantMessageEvent.delta }
        case 'error':
          return event.assistantMessageEvent.reason === 'aborted'
            ? adapterError(
                turnId,
                event.assistantMessageEvent.error.errorMessage,
                'The agent stopped before it finished.'
              )
            : adapterError(turnId, event.assistantMessageEvent.error.errorMessage)
        default:
          return undefined
      }

    default:
      return undefined
  }
}
