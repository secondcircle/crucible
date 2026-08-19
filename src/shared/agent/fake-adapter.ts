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

/**
 * The fake adapter: the deterministic, zero-cost implementation of the adapter
 * contract, and the default launch flavor (FA-1).
 *
 * It imports neither Electron nor the π SDK, so this one module serves the main
 * process, node unit tests and jsdom component tests alike. Everything it shows
 * is its own honest truth rather than a picture of somebody else's: the model
 * it lists says `fake` in its id and in its label, its usage numbers are the
 * ones it accumulated, and the thinking, tool and text events it emits are the
 * script it really ran. Nothing here exists to make the UI look busy.
 *
 * Its history is in memory and lasts one launch (FA-6). That is what makes
 * reset and resume observable at zero cost — a conversation detached by reset
 * is still searchable, and resuming it brings its transcript back — and it is
 * also why a relaunch finds the history empty while the curated sidebar, which
 * is main's own persisted state, is still there. An in-memory adapter that
 * pretended otherwise would be the one dishonest thing in the flavor.
 */

/** The only model this adapter can reach, and it says so in its own name. */
export const FAKE_MODEL: ModelInfo = {
  id: 'fake/deterministic',
  label: 'Fake · deterministic (no network, no cost)',
  // Native-style levels, more than one, so the thinking control is genuinely
  // exercisable in the fake flavor (FA-2).
  thinkingLevels: ['off', 'low', 'high']
}

/** What a fake conversation pretends to have room for. */
const CONTEXT_WINDOW = 200_000

/**
 * The pause between beats when nobody says otherwise — long enough that a turn
 * visibly streams in the running app, short enough that it is over in about two
 * seconds. Tests pass zero, which runs the whole script on microtasks so no
 * test waits on a clock (FA-3).
 */
const DEFAULT_PAUSE_MS = 45

/** The thinking the script shows, split the way it streams. */
const THINKING_DELTAS: readonly string[] = [
  'The reply has to show every region of the shell: ',
  'a thinking block, a tool call that really runs, ',
  'and markdown with a list and a fenced block.'
]

/** The tool call the script runs. */
const TOOL = {
  name: 'bash',
  summary: 'npm test',
  chunks: [
    ' Test Files  8 passed (8)\n',
    '      Tests  42 passed (42)\n',
    '   Duration  1.18s\n'
  ]
} as const

/** The reply, split the way it streams. */
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

/** The canned history every workspace starts with, so resume is demonstrable. */
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

/** A conversation this adapter is keeping, bound or detached. */
interface Conversation {
  readonly token: string
  readonly workspacePath: string
  readonly items: TranscriptItem[]
  /** Monotonic within the conversation, and inside the context window (FA-7). */
  usedTokens: number
  /** ISO time of the last thing that happened in it. */
  at: string
}

/** What this adapter holds for one bound session. */
interface Bound {
  conversation: Conversation
  model: ModelId
  thinkingLevel: ThinkingLevel
  /** The turn in flight, if any: one per session, many per adapter (FA-5). */
  running?: RunningTurn
}

/** A turn in flight, from the outside: the one thing that can be done to it. */
interface RunningTurn {
  readonly turnId: TurnId
  /** Stop the script where it stands; nothing more is emitted for this turn. */
  abandon(reason: 'cancelled' | 'disposed'): void
}

/** A word-count-ish estimate: coherent, monotonic, and honestly approximate. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

/** How much of a conversation's last words a search result carries. */
const PREVIEW_LIMIT = 140

/** One line, and a short one: a preview is a scent, not the conversation. */
function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= PREVIEW_LIMIT ? line : `${line.slice(0, PREVIEW_LIMIT)}…`
}

/** The level a session starts on: the caller's, when this model has it. */
function preferredLevel(preferred: ThinkingLevel | undefined): ThinkingLevel {
  return preferred !== undefined && FAKE_MODEL.thinkingLevels.includes(preferred) ? preferred : 'low'
}

export function createFakeAdapter({
  pauseMs = DEFAULT_PAUSE_MS
}: {
  /** Milliseconds between beats. Zero runs the script on microtasks. */
  readonly pauseMs?: number
} = {}): ConversationAdapter {
  const listeners = new Set<AdapterEventListener>()
  /** Every conversation this launch has seen, bound or not, by token. */
  const conversations = new Map<string, Conversation>()
  const sessions = new Map<SessionId, Bound>()
  /** Workspaces whose canned history has already been laid down. */
  const seeded = new Set<string>()
  let minted = 0

  function emit(event: AdapterEvent): void {
    // A copy, so a listener that unsubscribes while being called does not
    // disturb the delivery of that same event to the others.
    for (const listener of [...listeners]) listener(event)
  }

  /**
   * Tokens say which kind of conversation they name, and that is load-bearing:
   * a canned entry has the same fixed content in every launch, so rebinding to
   * one after a relaunch restores exactly what it restored before, while a
   * conversation this launch created is gone when the launch is — and its token
   * must therefore match nothing rather than land on some other conversation
   * that happens to have been minted in the same order (FA-6).
   */
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

  /** The canned entries of FA-6, laid down once per workspace on first look. */
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

  /** What a conversation looks like in a search result: its last words. */
  function previewOf(conversation: Conversation): string {
    for (const item of [...conversation.items].reverse()) {
      if (item.kind === 'user') return clip(`you: ${item.text}`)
      if (item.kind === 'assistant') return clip(`agent: ${item.markdown}`)
    }
    return 'an empty conversation'
  }

  /**
   * What a search reads: everything said in the conversation, not just the
   * scent shown beside it — a person searching for a sentence they typed
   * expects to find the conversation they typed it in.
   */
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

  /**
   * One turn's script. Every beat is preceded by a pause and followed by an
   * abandonment check, so cancellation lands promptly wherever the script
   * stands and emits nothing after its terminal event (FA-4).
   */
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

    /** What is written into the conversation whichever way the turn ends. */
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
      // Usage is the adapter's own arithmetic and is reported after the turn,
      // which is when it is genuinely known (FA-7).
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

    /** The single terminal event, decided by how the script left off. */
    function finish(): void {
      if (stopped === 'disposed') {
        // The document that asked is gone: the work is dropped and the turn
        // says nothing more at all.
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

      // A session already bound this launch keeps the conversation it is on:
      // binding twice is a caller asking the same question twice, not an
      // instruction to start over.
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
        // One model is all this adapter can reach, so a preference for anything
        // else falls back to it — and what is reported is what is in effect,
        // fallback included (MO-4).
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
      // The old conversation is detached, not deleted: it stays in this
      // adapter's history and stays findable through search (A25).
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
      // sidebar entry, never the history behind it (A24).
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
      // Targeted by construction: only this session's turn is reachable from
      // here, and a session with nothing running is left alone (A3).
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
