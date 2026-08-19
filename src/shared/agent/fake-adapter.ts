import type {
  AdapterEvent,
  AdapterEventListener,
  BindRequest,
  Binding,
  ConversationAdapter,
  ResumeRequest
} from './adapter'
import type {
  HistoryMatch,
  ModelId,
  ModelInfo,
  SessionId,
  ThinkingLevel,
  TranscriptItem,
  TurnId
} from './port'

// Imports neither Electron nor the π SDK, so the same module serves the main
// process, node tests and jsdom tests. Its history lives in memory and lasts
// one launch, which is what keeps reset and resume observable at zero cost.

export const FAKE_MODEL: ModelInfo = {
  id: 'fake/deterministic',
  label: 'Fake · deterministic (no network, no cost)',
  // More than one level, so the thinking control is genuinely exercisable in
  // this flavor.
  thinkingLevels: ['off', 'low', 'high']
}

const CONTEXT_WINDOW = 200_000

// Long enough that a turn visibly streams, short enough that it is over in
// about two seconds. Tests pass zero and wait on no clock.
const DEFAULT_PAUSE_MS = 45

const THINKING_DELTAS: readonly string[] = [
  'The reply has to show every region of the shell: ',
  'a thinking block, a tool call that really runs, ',
  'and markdown with a list and a fenced block.'
]

const TOOL = {
  name: 'bash',
  summary: 'npm test',
  chunks: [
    ' Test Files  8 passed (8)\n',
    '      Tests  42 passed (42)\n',
    '   Duration  1.18s\n'
  ]
} as const

const REPLY_DELTAS: readonly string[] = [
  'The fake adapter answers every prompt with this same scripted turn.',
  ' Nothing was sent anywhere and nothing was paid for it.\n\n',
  'What the script covers:\n\n',
  '- a thinking block, dim and collapsed\n',
  '- a tool call that runs, streams output and finishes\n',
  '- markdown with `inline code`, a table and a fenced block\n\n',
  '| flavor | cost | default |\n| --- | --- | --- |\n',
  '| fake | none | yes |\n| sdk | metered | no |\n\n',
  '```ts\n',
  'const adapter = createFakeAdapter({ pauseMs: 0 })\n',
  "await adapter.prompt(sessionId, turnId, 'hello')\n",
  '```\n\n',
  'Stop or Escape ends this turn wherever it stands.'
]

// Every workspace starts with these, so resume has something to find.
const CANNED_HISTORY: readonly { readonly preview: string; readonly items: TranscriptItem[] }[] = [
  {
    preview: 'you: how does the agent port keep SDK types out of the renderer?',
    items: [
      { kind: 'user', text: 'How does the agent port keep SDK types out of the renderer?' },
      {
        kind: 'assistant',
        markdown:
          'The renderer only ever sees `AgentPort`, and that module imports nothing.\n\n' +
          '- main serves the port over typed IPC\n' +
          '- a component test hands the same interface in as a prop\n'
      }
    ]
  },
  {
    preview: 'you: draft the Ember palette as shared tokens',
    items: [
      { kind: 'user', text: 'Draft the Ember palette as shared tokens.' },
      {
        kind: 'assistant',
        markdown:
          'One token source, referenced by every component stylesheet:\n\n' +
          '```css\n--bg: #191419;\n--accent: #e07a4f;\n```\n'
      }
    ]
  }
]

interface Conversation {
  readonly token: string
  readonly workspacePath: string
  readonly items: TranscriptItem[]
  /** Monotonic within the conversation, and inside the context window. */
  usedTokens: number
  /** ISO time of the last thing that happened in it. */
  at: string
}

interface Bound {
  conversation: Conversation
  model: ModelId
  thinkingLevel: ThinkingLevel
  /** One per session, many per adapter. */
  running?: RunningTurn
}

interface RunningTurn {
  readonly turnId: TurnId
  /** Stops the script where it stands; nothing more is emitted for this turn. */
  abandon(reason: 'cancelled' | 'disposed'): void
}

// Deliberately approximate: the number only has to be coherent and monotonic.
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

const PREVIEW_LIMIT = 140

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= PREVIEW_LIMIT ? line : `${line.slice(0, PREVIEW_LIMIT)}…`
}

function preferredLevel(preferred: ThinkingLevel | undefined): ThinkingLevel {
  return preferred !== undefined && FAKE_MODEL.thinkingLevels.includes(preferred) ? preferred : 'low'
}

export function createFakeAdapter({
  pauseMs = DEFAULT_PAUSE_MS
}: {
  /** Zero runs the script on microtasks. */
  readonly pauseMs?: number
} = {}): ConversationAdapter {
  const listeners = new Set<AdapterEventListener>()
  /** Every conversation this launch has seen, bound or not, by token. */
  const conversations = new Map<string, Conversation>()
  const sessions = new Map<SessionId, Bound>()
  const seeded = new Set<string>()
  let minted = 0

  function emit(event: AdapterEvent): void {
    // A copy, so a listener that unsubscribes while being called does not
    // disturb the delivery of that same event to the others.
    for (const listener of [...listeners]) listener(event)
  }

  // The kind is in the token because canned conversations come back identical
  // next launch while live ones are gone: a stale live token must match
  // nothing rather than land on whatever was minted in the same order.
  function mintToken(kind: 'canned' | 'live'): string {
    minted += 1
    return `fake-${kind}-${minted}`
  }

  function newConversation(
    workspacePath: string,
    items: TranscriptItem[] = [],
    kind: 'canned' | 'live' = 'live'
  ): Conversation {
    const conversation: Conversation = {
      token: mintToken(kind),
      workspacePath,
      items,
      usedTokens: items.reduce((sum, item) => sum + estimateTokens(JSON.stringify(item)), 0),
      at: new Date().toISOString()
    }
    conversations.set(conversation.token, conversation)
    return conversation
  }

  /** Laid down once per workspace, on first look. */
  function seed(workspacePath: string): void {
    if (seeded.has(workspacePath)) return
    seeded.add(workspacePath)
    for (const canned of CANNED_HISTORY) {
      newConversation(workspacePath, [...canned.items], 'canned')
    }
  }

  function requireBound(sessionId: SessionId): Bound {
    const bound = sessions.get(sessionId)
    if (bound === undefined) throw new Error('That session is not bound to a conversation.')
    return bound
  }

  function previewOf(conversation: Conversation): string {
    for (const item of [...conversation.items].reverse()) {
      if (item.kind === 'user') return clip(`you: ${item.text}`)
      if (item.kind === 'assistant') return clip(`agent: ${item.markdown}`)
    }
    return 'an empty conversation'
  }

  // A search reads the whole conversation, not just the preview beside it: a
  // person looking for a sentence they typed expects to find it.
  function searchableText(conversation: Conversation): string {
    return conversation.items
      .map((item) => {
        if (item.kind === 'user') return item.text
        if (item.kind === 'assistant') return item.markdown
        if (item.kind === 'thinking') return item.text
        if (item.kind === 'tool') return `${item.name} ${item.summary}`
        return ''
      })
      .join('\n')
      .toLowerCase()
  }

  // Every beat is preceded by a pause and followed by an abandonment check, so
  // a cancel lands promptly wherever the script stands.
  function run(bound: Bound, sessionId: SessionId, turnId: TurnId, text: string): Promise<void> {
    let stopped: 'cancelled' | 'disposed' | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let release: (() => void) | undefined

    const turn: RunningTurn = {
      turnId,
      abandon(reason) {
        stopped = reason
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        release?.()
      }
    }
    bound.running = turn

    function beat(): Promise<void> {
      return new Promise<void>((resolve) => {
        release = resolve
        if (pauseMs <= 0) queueMicrotask(resolve)
        else timer = setTimeout(resolve, pauseMs)
      })
    }

    const conversation = bound.conversation
    const pending: TranscriptItem[] = [{ kind: 'user', text }]
    let thinking = ''
    let reply = ''
    let toolOutput = ''

    function settle(terminal: AdapterEvent): void {
      if (reply !== '') pending.push({ kind: 'assistant', markdown: reply })
      if (terminal.type === 'turn_cancelled') pending.push({ kind: 'stopped' })
      conversation.items.push(...pending)
      conversation.at = new Date().toISOString()
      conversation.usedTokens = Math.min(
        CONTEXT_WINDOW,
        conversation.usedTokens + estimateTokens(text + thinking + toolOutput + reply)
      )
      bound.running = undefined
      emit(terminal)
      // Reported after the turn, which is when it is genuinely known.
      emit({
        type: 'usage',
        sessionId,
        usedTokens: conversation.usedTokens,
        contextWindow: CONTEXT_WINDOW
      })
    }

    async function script(): Promise<void> {
      emit({ type: 'turn_started', sessionId, turnId })

      if (bound.thinkingLevel !== 'off') {
        const startedAt = Date.now()
        for (const delta of THINKING_DELTAS) {
          await beat()
          if (stopped !== undefined) return finish()
          thinking += delta
          emit({ type: 'thinking_delta', sessionId, turnId, delta })
        }
        pending.push({
          kind: 'thinking',
          text: thinking,
          seconds: Math.max(1, Math.round((Date.now() - startedAt) / 1000))
        })
      }

      const callId = `${turnId}-call-1`
      await beat()
      if (stopped !== undefined) return finish()
      emit({ type: 'tool_started', sessionId, turnId, callId, name: TOOL.name, summary: TOOL.summary })

      for (const chunk of TOOL.chunks) {
        await beat()
        if (stopped !== undefined) return finish()
        toolOutput += chunk
        emit({ type: 'tool_output', sessionId, turnId, callId, chunk })
      }

      await beat()
      if (stopped !== undefined) return finish()
      emit({ type: 'tool_ended', sessionId, turnId, callId, ok: true, output: toolOutput })
      pending.push({
        kind: 'tool',
        name: TOOL.name,
        summary: TOOL.summary,
        ok: true,
        output: toolOutput
      })

      for (const delta of REPLY_DELTAS) {
        await beat()
        if (stopped !== undefined) return finish()
        reply += delta
        emit({ type: 'text_delta', sessionId, turnId, delta })
      }

      await beat()
      if (stopped !== undefined) return finish()
      finish()
    }

    function finish(): void {
      if (stopped === 'disposed') {
        // The document that asked is gone, so the turn says nothing more at
        // all, not even a terminal event.
        bound.running = undefined
        return
      }
      settle(
        stopped === 'cancelled'
          ? { type: 'turn_cancelled', sessionId, turnId }
          : { type: 'turn_ended', sessionId, turnId }
      )
    }

    return script()
  }

  return {
    async bind(request: BindRequest): Promise<Binding> {
      seed(request.workspacePath)

      // Binding twice is a caller asking the same question twice, not an
      // instruction to start the conversation over.
      const already = sessions.get(request.sessionId)
      if (
        already !== undefined &&
        (request.token === undefined || already.conversation.token === request.token)
      ) {
        return {
          token: already.conversation.token,
          model: already.model,
          thinkingLevel: already.thinkingLevel,
          restored: true
        }
      }

      const existing = request.token === undefined ? undefined : conversations.get(request.token)
      const conversation = existing ?? newConversation(request.workspacePath)
      const bound: Bound = {
        // One model is all this adapter can reach, so any other preference
        // falls back to it and the fallback is what gets reported.
        conversation,
        model: FAKE_MODEL.id,
        thinkingLevel: preferredLevel(request.preferredThinkingLevel)
      }
      sessions.set(request.sessionId, bound)
      return {
        token: conversation.token,
        model: bound.model,
        thinkingLevel: bound.thinkingLevel,
        restored: existing !== undefined
      }
    },

    async reset(sessionId: SessionId): Promise<Binding> {
      const bound = requireBound(sessionId)
      bound.running?.abandon('disposed')
      // The old conversation is detached, not deleted: it stays findable
      // through search.
      const fresh = newConversation(bound.conversation.workspacePath)
      bound.conversation = fresh
      return {
        token: fresh.token,
        model: bound.model,
        thinkingLevel: bound.thinkingLevel,
        restored: false
      }
    },

    async resume(request: ResumeRequest): Promise<Binding> {
      seed(request.workspacePath)
      const conversation = conversations.get(request.ref)
      if (conversation === undefined) throw new Error('That conversation is no longer available.')
      const bound: Bound = {
        conversation,
        model: FAKE_MODEL.id,
        thinkingLevel: 'low'
      }
      sessions.set(request.sessionId, bound)
      return {
        token: conversation.token,
        model: bound.model,
        thinkingLevel: bound.thinkingLevel,
        restored: true
      }
    },

    async transcript(sessionId: SessionId): Promise<readonly TranscriptItem[]> {
      return [...requireBound(sessionId).conversation.items]
    },

    release(sessionId: SessionId): void {
      const bound = sessions.get(sessionId)
      bound?.running?.abandon('disposed')
      // The conversation itself stays in `conversations`: removal forgets the
      // sidebar entry, never the history behind it.
      sessions.delete(sessionId)
    },

    async searchHistory(workspacePath: string, query: string): Promise<readonly HistoryMatch[]> {
      seed(workspacePath)
      const wanted = query.trim().toLowerCase()
      return [...conversations.values()]
        .filter((conversation) => conversation.workspacePath === workspacePath)
        .filter(
          (conversation) => wanted === '' || searchableText(conversation).includes(wanted)
        )
        .map((conversation) => ({
          ref: conversation.token,
          preview: previewOf(conversation),
          at: conversation.at
        }))
        .sort((left, right) => right.at.localeCompare(left.at))
    },

    // Token and ref are the same opaque string in this adapter, which nothing
    // above the seam is told or has to know.
    sameConversation(token: string, ref: string): boolean {
      return token === ref
    },

    async listModels(): Promise<readonly ModelInfo[]> {
      return [FAKE_MODEL]
    },

    async setModel(sessionId: SessionId, model: ModelId): Promise<void> {
      if (model !== FAKE_MODEL.id) throw new Error('The fake adapter has only one model.')
      requireBound(sessionId).model = model
    },

    async setThinkingLevel(sessionId: SessionId, level: ThinkingLevel): Promise<void> {
      if (!FAKE_MODEL.thinkingLevels.includes(level)) {
        throw new Error('That thinking level is not one this model supports.')
      }
      requireBound(sessionId).thinkingLevel = level
    },

    prompt(sessionId: SessionId, turnId: TurnId, text: string): Promise<void> {
      const bound = requireBound(sessionId)
      return run(bound, sessionId, turnId, text)
    },

    async cancel(sessionId: SessionId): Promise<void> {
      sessions.get(sessionId)?.running?.abandon('cancelled')
    },

    onEvent(listener: AdapterEventListener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    // Subscriptions are left alone: whoever is listening keeps listening, and
    // hears the next turn in full. Only the work is dropped.
    dispose(): void {
      for (const bound of sessions.values()) bound.running?.abandon('disposed')
    }
  }
}
