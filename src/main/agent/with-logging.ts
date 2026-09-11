import type {
  ImageAttachment,
  PortEvent,
  QueuedEntry,
  SystemMessage
} from '../../shared/agent/port'
import type { Shell } from '../shell/shell'
import type { LogSink } from '../log/sink'

// A decorator at the port seam, so no adapter and no component has to remember
// to log, and no adapter is aware it is being logged.
export function withLogging(shell: Shell, log: LogSink, adapter: string): Shell {
  shell.onEvent((event) => {
    // The event's own `type` names the record, so the log reads back as the
    // sequence the port produced.
    const { type, ...detail } = describeEvent(event)
    log.append({ source: 'main', event: type, adapter, ...detail })
  })

  // Logged verbatim unless `describe` or `answer` cuts it down: a log that
  // cannot be read back against what was asked tells a reader nothing.
  function op<A extends unknown[], R>(
    name: string,
    run: (...args: A) => Promise<R>,
    describe?: (...args: A) => unknown[],
    answer?: (result: R) => unknown
  ): (...args: A) => Promise<R> {
    return async (...args: A): Promise<R> => {
      log.append({
        source: 'main',
        event: name,
        adapter,
        args: describe === undefined ? args : describe(...args)
      })
      try {
        const result = await run(...args)
        if (result !== undefined) {
          log.append({
            source: 'main',
            event: `${name}_answered`,
            adapter,
            result: answer === undefined ? result : answer(result)
          })
        }
        return result
      } catch (cause) {
        // The stack belongs here and nowhere else: what crosses the port is
        // display-safe text, and this record keeps the rest.
        log.append({
          source: 'main',
          event: `${name}_refused`,
          adapter,
          args: describe === undefined ? args : describe(...args),
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

    createSession: op('createSession', (workspaceId, options) =>
      shell.createSession(workspaceId, options)
    ),
    activateSession: op('activateSession', (id) => shell.activateSession(id)),
    removeSession: op('removeSession', (id) => shell.removeSession(id)),
    resetSession: op('resetSession', (id) => shell.resetSession(id)),
    transcript: op('transcript', (id) => shell.transcript(id)),

    searchHistory: op('searchHistory', (workspaceId, query) =>
      shell.searchHistory(workspaceId, query)
    ),
    resumeSession: op('resumeSession', (workspaceId, ref) => shell.resumeSession(workspaceId, ref)),

    setWorktree: op('setWorktree', (sessionId, worktree) =>
      shell.setWorktree(sessionId, worktree)
    ),

    listModels: op('listModels', () => shell.listModels()),
    setModel: op('setModel', (sessionId, model) => shell.setModel(sessionId, model)),
    setThinkingLevel: op('setThinkingLevel', (sessionId, level) =>
      shell.setThinkingLevel(sessionId, level)
    ),

    listProviders: op('listProviders', () => shell.listProviders()),
    login: op('login', (providerId, method) => shell.login(providerId, method)),
    // The value is the credential itself, so only the prompt it answers is
    // recorded: nothing a person pasted reaches the run log.
    answerAuthPrompt: op(
      'answerAuthPrompt',
      (promptId, value) => shell.answerAuthPrompt(promptId, value),
      (promptId, value) => [promptId, { characters: value.length }]
    ),
    cancelLogin: op('cancelLogin', () => shell.cancelLogin()),
    logout: op('logout', (providerId) => shell.logout(providerId)),
    sessionUsage: op('sessionUsage', (id) => shell.sessionUsage(id)),

    sessionTree: op('sessionTree', (id) => shell.sessionTree(id)),
    jump: op('jump', (id, ref, options) => shell.jump(id, ref, options)),
    setLabel: op('setLabel', (id, ref, label) => shell.setLabel(id, ref, label)),

    prompt: op(
      'prompt',
      (sessionId, text, images) => shell.prompt(sessionId, text, images),
      // Base64 bytes never reach the run log: what a reader needs of an
      // attachment is its type and how big it was.
      (sessionId, text, images) =>
        images === undefined ? [sessionId, text] : [sessionId, text, images.map(describeImage)]
    ),
    shareBashRun: op('shareBashRun', (sessionId, run) => shell.shareBashRun(sessionId, run)),
    steer: op(
      'steer',
      (sessionId, text, images) => shell.steer(sessionId, text, images),
      describeQueueCall
    ),
    followUp: op(
      'followUp',
      (sessionId, text, images) => shell.followUp(sessionId, text, images),
      describeQueueCall
    ),
    deliver: op(
      'deliver',
      (sessionId, message, kind) => shell.deliver(sessionId, message, kind),
      (sessionId, message: SystemMessage, kind) => [
        sessionId,
        message.card === undefined
          ? { text: message.text }
          : { text: message.text, card: message.card.title },
        kind ?? 'followUp'
      ]
    ),
    dequeue: op(
      'dequeue',
      (sessionId, kind, text) => shell.dequeue(sessionId, kind, text),
      undefined,
      // The answer carries the pictures that left the queue, and those are the
      // one thing a log line must not repeat.
      (removed) => (removed === undefined ? removed : describeEntry(removed))
    ),

    replyToQuestion: op('replyToQuestion', (sessionId, questionId, reply) =>
      shell.replyToQuestion(sessionId, questionId, reply)
    ),

    activateTab: op('activateTab', (sessionId, tabId) => shell.activateTab(sessionId, tabId)),
    closeTab: op('closeTab', (sessionId, tabId) => shell.closeTab(sessionId, tabId)),
    exhibit: op(
      'exhibit',
      (sessionId, tabId) => shell.exhibit(sessionId, tabId),
      undefined,
      ({ body }) => ({ characters: body.length })
    ),

    cancel: op('cancel', (sessionId) => shell.cancel(sessionId)),

    dispose: () => {
      log.append({ source: 'main', event: 'shell_disposed', adapter })
      shell.dispose()
    }
  }
}

function describeImage(image: ImageAttachment): { mimeType: string; bytes: number } {
  // The base64 length, which is within a few bytes of the file's own size and
  // costs nothing to measure.
  return { mimeType: image.mimeType, bytes: Math.floor((image.data.length * 3) / 4) }
}

function describeQueueCall(
  sessionId: string,
  text: string,
  images?: readonly ImageAttachment[]
): unknown[] {
  return images === undefined ? [sessionId, text] : [sessionId, text, images.map(describeImage)]
}

/** A record as the log holds it: the port's own fields, bytes excepted. */
type Described = { readonly [field: string]: unknown }

function describeEntry(entry: QueuedEntry): Described {
  return entry.images === undefined
    ? { ...entry }
    : { ...entry, images: entry.images.map(describeImage) }
}

// A queued 10 MB screenshot would otherwise ride every state record, as
// base64, for as long as it sits in the queue.
function describeEvent(event: PortEvent): Described & { readonly type: string } {
  if (event.type === 'state') {
    return {
      ...event,
      snapshot: {
        ...event.snapshot,
        sessions: event.snapshot.sessions.map((session) =>
          session.queue === undefined
            ? session
            : {
                ...session,
                queue: {
                  steering: session.queue.steering.map(describeEntry),
                  followUp: session.queue.followUp.map(describeEntry)
                }
              }
        )
      }
    }
  }
  if (event.type === 'user_message') {
    return event.images === undefined
      ? event
      : { ...event, images: event.images.map(describeImage) }
  }
  if (event.type === 'queue_flushed') {
    return { ...event, messages: event.messages.map(describeEntry) }
  }
  return event
}
