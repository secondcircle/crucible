import type { Shell } from '../shell/shell'
import type { LogSink } from '../log/sink'

/**
 * Logging is a decorator at the agent-port seam (LF-2).
 *
 * `withLogging` wraps the shell and records every operation asked of the port,
 * every answer, every refusal and every event that came back out. It adds
 * nothing to the port — a caller of the wrapped shell cannot tell it from the
 * one that was wrapped, which is the point: no adapter and no component knows
 * logging exists, and coverage arrives with the seam rather than with each
 * implementation remembering to log.
 *
 * What it hides: the record shapes, the field names, the fact that events are
 * observed through a subscription of its own rather than through a caller's,
 * and that a failed operation is recorded before it is re-thrown. All of it is
 * one module's business because everything goes through one `append`.
 *
 * The third argument is the identity: an adapter cannot be asked its name
 * without every adapter knowing why it was asked, so the wrapper is told at the
 * one place that already knows — the launch flavor. The name goes on every
 * record this wrapper writes, so a reader of any single line knows which
 * flavor produced it.
 */
export function withLogging(shell: Shell, log: LogSink, adapter: string): Shell {
  shell.onEvent((event) => {
    // The port event's own `type` names the record, so the log reads as the
    // sequence the port produced — `turn_started`, `text_delta`, … — each with
    // whatever else that event carries. A `state` event carries the snapshot,
    // which is the one record a reader can reconstruct the sidebar from.
    const { type, ...detail } = event
    log.append({ source: 'main', event: type, adapter, ...detail })
  })

  /**
   * One port operation, recorded around its call. The arguments are logged
   * verbatim, prompt text included: this is a local run log, and a turn that
   * cannot be read back against what was asked is not diagnostic.
   */
  function op<A extends unknown[], R>(
    name: string,
    run: (...args: A) => Promise<R>
  ): (...args: A) => Promise<R> {
    return async (...args: A): Promise<R> => {
      log.append({ source: 'main', event: name, adapter, args })
      try {
        const result = await run(...args)
        if (result !== undefined) {
          log.append({ source: 'main', event: `${name}_answered`, adapter, result })
        }
        return result
      } catch (cause) {
        // The stack belongs here and nowhere else: what crosses the port is
        // display-safe text, and this is the record that still has the rest.
        log.append({
          source: 'main',
          event: `${name}_refused`,
          adapter,
          args,
          message: cause instanceof Error ? cause.message : String(cause),
          stack: cause instanceof Error ? cause.stack : undefined
        })
        throw cause
      }
    }
  }

  return {
    // Read-only and called on every state change; logging it would drown the
    // file in copies of what the `state` records already say.
    snapshot: () => shell.snapshot(),
    onEvent: (listener) => shell.onEvent(listener),

    addWorkspace: op('addWorkspace', () => shell.addWorkspace()),
    activateWorkspace: op('activateWorkspace', (id) => shell.activateWorkspace(id)),
    removeWorkspace: op('removeWorkspace', (id) => shell.removeWorkspace(id)),

    createSession: op('createSession', (workspaceId) => shell.createSession(workspaceId)),
    activateSession: op('activateSession', (id) => shell.activateSession(id)),
    removeSession: op('removeSession', (id) => shell.removeSession(id)),
    resetSession: op('resetSession', (id) => shell.resetSession(id)),
    transcript: op('transcript', (id) => shell.transcript(id)),

    searchHistory: op('searchHistory', (workspaceId, query) =>
      shell.searchHistory(workspaceId, query)
    ),
    resumeSession: op('resumeSession', (workspaceId, ref) => shell.resumeSession(workspaceId, ref)),

    listModels: op('listModels', () => shell.listModels()),
    setModel: op('setModel', (sessionId, model) => shell.setModel(sessionId, model)),
    setThinkingLevel: op('setThinkingLevel', (sessionId, level) =>
      shell.setThinkingLevel(sessionId, level)
    ),

    prompt: op('prompt', (sessionId, text) => shell.prompt(sessionId, text)),
    cancel: op('cancel', (sessionId) => shell.cancel(sessionId)),

    dispose: () => {
      log.append({ source: 'main', event: 'shell_disposed', adapter })
      shell.dispose()
    }
  }
}
