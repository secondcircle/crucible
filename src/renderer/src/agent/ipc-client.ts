import type { PortRequest, PortResult } from '../../../shared/agent/channels'
import type {
  AgentPort,
  HistoryMatch,
  ModelId,
  ModelInfo,
  PortEvent,
  PortEventListener,
  SessionId,
  ShellSnapshot,
  ThinkingLevel,
  TranscriptItem,
  TurnId,
  Unsubscribe,
  WorkspaceId
} from '../../../shared/agent/port'

/**
 * The renderer's half of the agent channel: an agent port over the preload
 * surface.
 *
 * This is the one module in the renderer that may name `window.crucible` — the
 * import fence says so — and it exists so that nothing else has to. What it
 * hands back is the port and only the port, so the shell it feeds cannot tell
 * that a process boundary was crossed at all.
 *
 * It is deliberately thin. Correlation, guards and staleness are main's
 * business now that every event carries the session it belongs to and main
 * drops anything that is not a live turn's, so there is nothing left here to
 * hold: a request goes out, a result comes back, and a refusal that crossed as
 * a value becomes a rejection carrying exactly the sentence main wrote.
 *
 * It subscribes to the preload surface once, when it is built, and fans out to
 * its own listeners, so subscribing and unsubscribing a component costs nothing
 * and loses nothing — the client is the document's, not a component's.
 */

/** The preload surface, as the renderer sees it: one object, two members. */
interface CrucibleAgent {
  request(request: PortRequest): Promise<PortResult>
  onEvent(listener: (event: PortEvent) => void): () => void
}

declare global {
  interface Window {
    crucible?: { agent: CrucibleAgent }
  }
}

/** The surface, or the one failure worth naming: a preload that did not load. */
function surface(): CrucibleAgent {
  const agent = window.crucible?.agent
  if (agent === undefined) {
    throw new Error('renderer: window.crucible is missing — the preload did not load')
  }
  return agent
}

export function createIpcClient(): AgentPort {
  const agent = surface()
  const listeners = new Set<PortEventListener>()

  agent.onEvent((event) => {
    // A copy, so a listener that unsubscribes while being called does not
    // disturb the delivery of that same event to the others.
    for (const listener of [...listeners]) listener(event)
  })

  async function call<T>(op: string, ...args: readonly unknown[]): Promise<T> {
    const result = await agent.request({ op, args })
    if (!result.ok) throw new Error(result.message)
    return result.value as T
  }

  return {
    snapshot: () => call<ShellSnapshot>('snapshot'),

    onEvent(listener: PortEventListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    addWorkspace: () => call<WorkspaceId | null>('addWorkspace'),
    activateWorkspace: (id: WorkspaceId) => call<void>('activateWorkspace', id),
    removeWorkspace: (id: WorkspaceId) => call<void>('removeWorkspace', id),

    createSession: (workspaceId: WorkspaceId) => call<SessionId>('createSession', workspaceId),
    activateSession: (id: SessionId) => call<void>('activateSession', id),
    removeSession: (id: SessionId) => call<void>('removeSession', id),
    resetSession: (id: SessionId) => call<void>('resetSession', id),
    transcript: (id: SessionId) => call<readonly TranscriptItem[]>('transcript', id),

    searchHistory: (workspaceId: WorkspaceId, query: string) =>
      call<readonly HistoryMatch[]>('searchHistory', workspaceId, query),
    resumeSession: (workspaceId: WorkspaceId, ref: string) =>
      call<SessionId>('resumeSession', workspaceId, ref),

    listModels: () => call<readonly ModelInfo[]>('listModels'),
    setModel: (sessionId: SessionId, model: ModelId) => call<void>('setModel', sessionId, model),
    setThinkingLevel: (sessionId: SessionId, level: ThinkingLevel) =>
      call<void>('setThinkingLevel', sessionId, level),

    prompt: (sessionId: SessionId, text: string) => call<TurnId>('prompt', sessionId, text),
    cancel: (sessionId: SessionId) => call<void>('cancel', sessionId)
  }
}
