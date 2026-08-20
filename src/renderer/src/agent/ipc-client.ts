import type { PortRequest, PortResult } from '../../../shared/agent/channels'
import type {
  AgentPort,
  HistoryMatch,
  ModelId,
  ModelInfo,
  PortEvent,
  PortEventListener,
  QueuedKind,
  SessionId,
  ShellSnapshot,
  ThinkingLevel,
  TranscriptItem,
  TurnId,
  Unsubscribe,
  WorkspaceId
} from '../../../shared/agent/port'

// The one module in the renderer that may name `window.crucible`. It holds no
// state: correlation, guards and staleness are all main's.

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

// A missing surface means the preload did not load, which is worth saying
// plainly rather than failing on an undefined member later.
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
    steer: (sessionId: SessionId, text: string) => call<void>('steer', sessionId, text),
    followUp: (sessionId: SessionId, text: string) => call<void>('followUp', sessionId, text),
    dequeue: (sessionId: SessionId, kind: QueuedKind, text: string) =>
      call<boolean>('dequeue', sessionId, kind, text),
    cancel: (sessionId: SessionId) => call<void>('cancel', sessionId)
  }
}
