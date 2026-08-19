import type { Shell } from '../shell/shell'
import type { LogSink } from '../log/sink'

// Logging is a decorator at the port seam so no adapter and no component has
// to remember to log. The adapter's name is passed in rather than asked of the
// adapter, which would make every adapter aware it is being logged.
export function withLogging(shell: Shell, log: LogSink, adapter: string): Shell {
  shell.onEvent((event) => {
    // The event's own `type` names the record, so the log reads back as the
    // sequence the port produced.
    const { type, ...detail } = event
    log.append({ source: 'main', event: type, adapter, ...detail })
  })

  // Arguments are logged verbatim, prompt text included: this is a local run
  // log, and a turn that cannot be read back against what was asked tells a
  // reader nothing.
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
        // display-safe text, and this record keeps the rest.
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
