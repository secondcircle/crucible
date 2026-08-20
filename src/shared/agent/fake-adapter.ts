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
  QueuedKind,
  QueuedMessage,
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

interface ScriptedCall {
  readonly name: string
  readonly summary: string
  readonly ok: boolean
  readonly chunks: readonly string[]
}

// Three consecutive calls under two names, one of them a failure, so a single
// scripted turn exercises the multi-name counts and the failure marker of a
// tool chain without a paid call.
const CHAIN: readonly ScriptedCall[] = [
  {
    name: 'bash',
    summary: 'npm test',
    ok: true,
    chunks: [
      ' Test Files  8 passed (8)\n',
      '      Tests  42 passed (42)\n',
      '   Duration  1.18s\n'
    ]
  },
  {
    name: 'read',
    summary: 'src/shared/agent/port.ts',
    ok: true,
    chunks: ['// This module imports nothing on purpose\n']
  },
  {
    name: 'read',
    summary: 'docs/design/feature-inventory.md',
    ok: false,
    chunks: ['ENOENT: no such file or directory\n']
  }
]

// Assistant text rather than a thought, so the chain ends here at every
// thinking level.
const BETWEEN_DELTAS: readonly string[] = [
  'One of those files is not there. Listing the folder instead.\n'
]

// A chain of one, which renders in the same grammar as the run of three.
const LONE_CALL: ScriptedCall = {
  name: 'bash',
  summary: 'ls docs/design',
  ok: true,
  chunks: ['m1-parity-core.md\nmock-a-ember.html\n']
}

const REPLY_DELTAS: readonly string[] = [
  'The fake adapter answers every prompt with this same scripted turn.',
  ' Nothing was sent anywhere and nothing was paid for it.\n\n',
  'What the script covers:\n\n',
  '- a thinking block, dim and collapsed\n',
  '- a chain of three calls, one of which fails, and a lone call after it\n',
  '- markdown with `inline code`, a table and a fenced block\n\n',
  '| flavor | cost | default |\n| --- | --- | --- |\n',
  '| fake | none | yes |\n| sdk | metered | no |\n\n',
  '```ts\n',
  'const adapter = createFakeAdapter({ pauseMs: 0 })\n',
  "await adapter.prompt(sessionId, turnId, 'hello')\n",
  '```\n\n',
  'Stop or Escape ends this turn wherever it stands.'
]

// Delivered queued messages are answered, briefly and honestly: the script has
// one answer and no model was asked for another.
const STEERING_ANSWER_DELTAS: readonly string[] = [
  'Steering taken. The script has only this one answer, and nothing was sent anywhere.'
]

const FOLLOW_UP_ANSWER_DELTAS: readonly string[] = [
  'Follow-up taken, once the rest was done. Still the same scripted answer.'
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
  /** π's two queues, oldest first, undelivered only. */
  readonly steering: string[]
  readonly followUp: string[]
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

  function emitQueue(bound: Bound, sessionId: SessionId): void {
    emit({
      type: 'queue_changed',
      sessionId,
      steering: [...bound.steering],
      followUp: [...bound.followUp]
    })
  }

  /** Hands every undelivered message back, steering first, and empties both queues. */
  function flushQueue(bound: Bound, sessionId: SessionId): void {
    const messages: QueuedMessage[] = [
      ...bound.steering.map((text): QueuedMessage => ({ kind: 'steering', text })),
      ...bound.followUp.map((text): QueuedMessage => ({ kind: 'followUp', text }))
    ]
    bound.steering.length = 0
    bound.followUp.length = 0
    if (messages.length === 0) return
    emit({ type: 'queue_flushed', sessionId, messages })
  }

  /** Silent: releasing or disposing leaves nowhere to restore a queue to. */
  function discardQueue(bound: Bound): void {
    bound.steering.length = 0
    bound.followUp.length = 0
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
    /** The assistant block being streamed, settled at every block boundary. */
    let spoken = ''
    /** Everything this turn produced, which is what the usage estimate reads. */
    let counted = text

    function settleSpoken(): void {
      if (spoken === '') return
      pending.push({ kind: 'assistant', markdown: spoken })
      counted += spoken
      spoken = ''
    }

    function settle(terminal: AdapterEvent): void {
      settleSpoken()
      if (terminal.type === 'turn_cancelled') pending.push({ kind: 'stopped' })
      // Delivered messages are settled at their delivery point, so a restored
      // transcript reads as the live one did.
      conversation.items.push(...pending)
      conversation.at = new Date().toISOString()
      conversation.usedTokens = Math.min(
        CONTEXT_WINDOW,
        conversation.usedTokens + estimateTokens(counted)
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

    /** False once the script has been abandoned, which ends every loop. */
    async function say(deltas: readonly string[]): Promise<boolean> {
      for (const delta of deltas) {
        await beat()
        if (stopped !== undefined) return false
        spoken += delta
        emit({ type: 'text_delta', sessionId, turnId, delta })
      }
      settleSpoken()
      return true
    }

    async function think(): Promise<boolean> {
      if (bound.thinkingLevel === 'off') return true
      const startedAt = Date.now()
      let thinking = ''
      for (const delta of THINKING_DELTAS) {
        await beat()
        if (stopped !== undefined) return false
        thinking += delta
        emit({ type: 'thinking_delta', sessionId, turnId, delta })
      }
      counted += thinking
      pending.push({
        kind: 'thinking',
        text: thinking,
        seconds: Math.max(1, Math.round((Date.now() - startedAt) / 1000))
      })
      return true
    }

    async function call(scripted: ScriptedCall, number: number): Promise<boolean> {
      settleSpoken()
      const callId = `${turnId}-call-${number}`
      await beat()
      if (stopped !== undefined) return false
      emit({
        type: 'tool_started',
        sessionId,
        turnId,
        callId,
        name: scripted.name,
        summary: scripted.summary
      })

      let output = ''
      for (const chunk of scripted.chunks) {
        await beat()
        if (stopped !== undefined) return false
        output += chunk
        emit({ type: 'tool_output', sessionId, turnId, callId, chunk })
      }

      await beat()
      if (stopped !== undefined) return false
      emit({ type: 'tool_ended', sessionId, turnId, callId, ok: scripted.ok, output })
      counted += output
      pending.push({
        kind: 'tool',
        name: scripted.name,
        summary: scripted.summary,
        ok: scripted.ok,
        output
      })
      return true
    }

    // A delivery point: everything queued of that kind goes in one group,
    // oldest first, and each message is announced as it lands.
    async function deliver(kind: QueuedKind): Promise<boolean> {
      const queue = kind === 'steering' ? bound.steering : bound.followUp
      while (queue.length > 0) {
        await beat()
        if (stopped !== undefined) return false
        const message = queue.shift() ?? ''
        settleSpoken()
        counted += message
        pending.push({ kind: 'user', text: message })
        emit({ type: 'user_message', sessionId, turnId, text: message })
        emitQueue(bound, sessionId)
      }
      return true
    }

    // The turn ends only when both queues are empty: steering first, because a
    // follow-up waits for the agent to have fully stopped.
    async function drain(): Promise<boolean> {
      for (;;) {
        if (bound.steering.length > 0) {
          if (!(await deliver('steering'))) return false
          if (!(await say(STEERING_ANSWER_DELTAS))) return false
          continue
        }
        if (bound.followUp.length > 0) {
          if (!(await deliver('followUp'))) return false
          if (!(await say(FOLLOW_UP_ANSWER_DELTAS))) return false
          continue
        }
        return true
      }
    }

    async function script(): Promise<void> {
      emit({ type: 'turn_started', sessionId, turnId })

      if (!(await think())) return finish()

      let number = 0
      for (const scripted of CHAIN) {
        number += 1
        if (!(await call(scripted, number))) return finish()
        // The boundary between two tool calls is where steering lands.
        if (!(await deliver('steering'))) return finish()
      }

      if (!(await say(BETWEEN_DELTAS))) return finish()
      if (!(await call(LONE_CALL, number + 1))) return finish()
      if (!(await deliver('steering'))) return finish()
      if (!(await say(REPLY_DELTAS))) return finish()

      // The pause before a turn ends is a window in which the session is still
      // running, so a message can still be queued into it. The queues are read
      // again after that pause, and only a beat nothing arrived in ends the
      // turn: between the last read and `finish()` there is no await, so
      // nothing can slip in behind the terminal event.
      for (;;) {
        if (!(await drain())) return finish()
        await beat()
        if (stopped !== undefined) return finish()
        if (bound.steering.length === 0 && bound.followUp.length === 0) break
      }
      finish()
    }

    function finish(): void {
      if (stopped === 'disposed') {
        // The document that asked is gone, so the turn says nothing more at
        // all, not even a terminal event, and there is nowhere left to restore
        // a queue to.
        discardQueue(bound)
        bound.running = undefined
        return
      }
      // Flushed before the terminal event, so no turn ever ends with a message
      // still queued behind it.
      if (stopped === 'cancelled') flushQueue(bound, sessionId)
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
        thinkingLevel: preferredLevel(request.preferredThinkingLevel),
        steering: [],
        followUp: []
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
        thinkingLevel: 'low',
        steering: [],
        followUp: []
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
      if (bound !== undefined) discardQueue(bound)
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

    // Nothing is queued into a session with no live run: the caller is told so
    // and sends the text as a prompt instead, which is what keeps a message
    // from sitting unheard in an idle conversation.
    async steer(sessionId: SessionId, text: string): Promise<'queued' | 'idle'> {
      const bound = requireBound(sessionId)
      if (bound.running === undefined) return 'idle'
      bound.steering.push(text)
      emitQueue(bound, sessionId)
      return 'queued'
    },

    async followUp(sessionId: SessionId, text: string): Promise<'queued' | 'idle'> {
      const bound = requireBound(sessionId)
      if (bound.running === undefined) return 'idle'
      bound.followUp.push(text)
      emitQueue(bound, sessionId)
      return 'queued'
    },

    async dequeue(sessionId: SessionId, kind: QueuedKind, text: string): Promise<boolean> {
      const bound = sessions.get(sessionId)
      if (bound === undefined) return false
      const queue = kind === 'steering' ? bound.steering : bound.followUp
      // The first match, because that is the one the strip shows first and the
      // one delivery would take next.
      const index = queue.indexOf(text)
      if (index === -1) return false
      queue.splice(index, 1)
      emitQueue(bound, sessionId)
      return true
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
      for (const bound of sessions.values()) {
        bound.running?.abandon('disposed')
        discardQueue(bound)
      }
    }
  }
}
