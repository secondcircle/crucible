import type { AgentAdapter, PortEventListener, TurnId, Unsubscribe } from '../../shared/agent/port'
import type { LogSink } from '../log/sink'

/**
 * Logging is a decorator at the agent-port seam (D8).
 *
 * `withLogging` wraps any adapter and records which adapter answered, the
 * prompt it was given, every event it emitted and every error it raised. It
 * adds nothing to the agent port — a caller of the wrapped adapter cannot tell
 * it from the one that was wrapped, which is the point: no adapter knows
 * logging exists, and coverage arrives with the seam rather than with each
 * implementation remembering to log.
 *
 * What it hides: the record shapes, the field names, the fact that events are
 * observed through a subscription of its own rather than through the caller's,
 * and that a failed prompt is recorded before it is re-thrown. All of it is one
 * module's business because everything goes through one `append` (D9).
 *
 * Three arguments rather than the two D8 writes, and the third is the identity:
 * an adapter cannot be asked its name without every adapter knowing why it was
 * asked, so the wrapper is told at the one place that already knows — the
 * launch flavor (D5). The name goes on every record this wrapper writes, so a
 * reader of any single line knows which adapter produced it.
 *
 * `withLogging` subscribes when it is built and never unsubscribes: it records
 * what the adapter did, not what some caller happened to be listening for.
 */
export function withLogging(port: AgentAdapter, log: LogSink, adapter: string): AgentAdapter {
  port.onEvent((event) => {
    // The port event's own `type` names the record, so the log reads as the
    // sequence the port produced — `turn_started`, `text_delta`, …, each with
    // its turn id and whatever else that event carries.
    const { type, ...detail } = event
    log.append({ source: 'main', event: type, adapter, ...detail })
  })

  return {
    async prompt(text: string): Promise<TurnId> {
      try {
        const turnId = await port.prompt(text)
        // A prompt and the turn that answered it are one fact, so they are one
        // record: the text verbatim (D8's edge case: no redaction this
        // milestone) under the id the adapter minted for it. Written once the
        // id is known, because the log contract puts `turnId` on anything
        // belonging to a turn and a prompt belongs to the turn it started —
        // there is no way here to write the prompt without it.
        log.append({ source: 'main', event: 'prompt', adapter, turnId, prompt: text })
        return turnId
      } catch (cause) {
        // A refused prompt never became a turn, so it has no id — the text is
        // what identifies it. The stack belongs here and nowhere else: an error
        // that crosses the port carries display-safe text only.
        log.append({
          source: 'main',
          event: 'prompt_failed',
          adapter,
          prompt: text,
          message: cause instanceof Error ? cause.message : String(cause),
          stack: cause instanceof Error ? cause.stack : undefined
        })
        throw cause
      }
    },

    onEvent(listener: PortEventListener): Unsubscribe {
      return port.onEvent(listener)
    },

    dispose(): void {
      port.dispose()
    }
  }
}
