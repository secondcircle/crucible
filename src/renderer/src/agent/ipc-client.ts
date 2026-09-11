import type {
  AgentPort,
  AuthMethod,
  BashRunShare,
  HistoryMatch,
  ImageAttachment,
  ModelId,
  ModelInfo,
  PortEventListener,
  PromptOptions,
  ProviderState,
  QuestionId,
  QuestionReply,
  QueuedEntry,
  QueuedKind,
  SessionId,
  SessionTree,
  SessionUsage,
  SessionWorktree,
  ShellSnapshot,
  TabId,
  ThinkingLevel,
  TranscriptItem,
  TurnId,
  Unsubscribe,
  WorkspaceId
} from '../../../shared/agent/port'
import { agentBridge } from '../bridge'

// The renderer's side of the agent channel. It holds no state: correlation,
// guards and staleness are all main's.

export function createIpcClient(): AgentPort {
  const agent = agentBridge()
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

    createSession: (workspaceId: WorkspaceId, options?: { readonly issue?: string }) =>
      call<SessionId>('createSession', workspaceId, options),
    activateSession: (id: SessionId) => call<void>('activateSession', id),
    removeSession: (id: SessionId) => call<void>('removeSession', id),
    resetSession: (id: SessionId) => call<void>('resetSession', id),
    transcript: (id: SessionId) => call<readonly TranscriptItem[]>('transcript', id),

    searchHistory: (workspaceId: WorkspaceId, query: string) =>
      call<readonly HistoryMatch[]>('searchHistory', workspaceId, query),
    resumeSession: (workspaceId: WorkspaceId, ref: string) =>
      call<SessionId>('resumeSession', workspaceId, ref),

    sessionTree: (id: SessionId) => call<SessionTree>('sessionTree', id),
    jump: (id: SessionId, ref: string, options: { readonly summarize: boolean }) =>
      call<{ cancelled: boolean; editorText?: string }>('jump', id, ref, options),
    // Nothing optional is sent as an absent argument: the wire carries what
    // there is, so a request reads as what was asked for.
    setLabel: (id: SessionId, ref: string, label?: string) =>
      label === undefined ? call<void>('setLabel', id, ref) : call<void>('setLabel', id, ref, label),

    // Nothing optional is sent as an absent argument: with no worktree the
    // request carries none, which is what a detach is.
    setWorktree: (sessionId: SessionId, worktree?: SessionWorktree) =>
      worktree === undefined
        ? call<void>('setWorktree', sessionId)
        : call<void>('setWorktree', sessionId, worktree),

    listModels: () => call<readonly ModelInfo[]>('listModels'),

    listProviders: () => call<readonly ProviderState[]>('listProviders'),
    login: (providerId: string, method: AuthMethod) => call<void>('login', providerId, method),
    answerAuthPrompt: (promptId: string, value: string) =>
      call<void>('answerAuthPrompt', promptId, value),
    cancelLogin: () => call<void>('cancelLogin'),
    logout: (providerId: string) => call<void>('logout', providerId),
    sessionUsage: (id: SessionId) => call<SessionUsage | undefined>('sessionUsage', id),

    setModel: (sessionId: SessionId, model: ModelId) => call<void>('setModel', sessionId, model),
    setThinkingLevel: (sessionId: SessionId, level: ThinkingLevel) =>
      call<void>('setThinkingLevel', sessionId, level),

    prompt: (
      sessionId: SessionId,
      text: string,
      images?: readonly ImageAttachment[],
      options?: PromptOptions
    ) => {
      const attached = images === undefined || images.length === 0 ? undefined : images
      // The options ride fourth, so a prompt that carries them and no pictures
      // sends an empty list where the pictures would go.
      if (options?.expiryAcknowledged === true) {
        return call<TurnId>('prompt', sessionId, text, attached ?? [], options)
      }
      return attached === undefined
        ? call<TurnId>('prompt', sessionId, text)
        : call<TurnId>('prompt', sessionId, text, attached)
    },
    shareBashRun: (sessionId: SessionId, run: BashRunShare) =>
      call<'delivered' | 'dropped'>('shareBashRun', sessionId, run),
    // Nothing optional is sent as an absent argument, exactly as the prompt
    // above does it.
    steer: (sessionId: SessionId, text: string, images?: readonly ImageAttachment[]) =>
      images === undefined || images.length === 0
        ? call<void>('steer', sessionId, text)
        : call<void>('steer', sessionId, text, images),
    followUp: (sessionId: SessionId, text: string, images?: readonly ImageAttachment[]) =>
      images === undefined || images.length === 0
        ? call<void>('followUp', sessionId, text)
        : call<void>('followUp', sessionId, text, images),
    dequeue: (sessionId: SessionId, kind: QueuedKind, text: string) =>
      call<QueuedEntry | undefined>('dequeue', sessionId, kind, text),

    replyToQuestion: (sessionId: SessionId, questionId: QuestionId, reply: QuestionReply) =>
      call<void>('replyToQuestion', sessionId, questionId, reply),

    activateTab: (sessionId: SessionId, tabId: TabId) =>
      call<void>('activateTab', sessionId, tabId),
    closeTab: (sessionId: SessionId, tabId: TabId) => call<void>('closeTab', sessionId, tabId),
    // The body is read in main at call time; nothing about where the file sits
    // crosses back.
    exhibit: (sessionId: SessionId, tabId: TabId) =>
      call<{ readonly body: string }>('exhibit', sessionId, tabId),

    cancel: (sessionId: SessionId) => call<void>('cancel', sessionId)
  }
}
