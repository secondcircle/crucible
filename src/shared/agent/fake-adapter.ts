import { summarizeActivity } from './activity'
import type {
  AdapterEvent,
  AdapterEventListener,
  BindRequest,
  Binding,
  ConversationAdapter,
  ResumeRequest,
  UsageRequest
} from './adapter'
import type { PanelToolName, PanelTools } from './panel-tools'
import type {
  AuthMethod,
  BashRunShare,
  HistoryMatch,
  ImageAttachment,
  ModelId,
  ModelInfo,
  ProviderState,
  QueuedKind,
  QueuedMessage,
  SessionId,
  SessionTree,
  SessionUsage,
  ThinkingLevel,
  TranscriptItem,
  TreeNode,
  TurnId
} from './port'

// Imports neither Electron nor the π SDK, so the same module serves the main
// process and both test environments. Its history lasts one launch.

export const FAKE_MODEL: ModelInfo = {
  id: 'fake/deterministic',
  label: 'Fake · deterministic (no network, no cost)',
  // More than one level, so the thinking control is genuinely exercisable in
  // this flavor.
  thinkingLevels: ['off', 'low', 'high']
}

const CONTEXT_WINDOW = 200_000

// What one scripted turn costs, in π's own per-message shape. Fixed, so the
// chip, the cards and both usage tables are checkable for free.
export const FAKE_TURN_USAGE = {
  input: { tokens: 4_210, cost: 0.06 },
  output: { tokens: 18_772, cost: 0.56 },
  cacheRead: { tokens: 36_900, cost: 0.11 },
  cacheWrite: { tokens: 2_100, cost: 0.11 }
} as const

/** 61,982 tokens and 84 cents a turn, every line of it visible at two decimals. */
const TURN_TOKENS =
  FAKE_TURN_USAGE.input.tokens +
  FAKE_TURN_USAGE.output.tokens +
  FAKE_TURN_USAGE.cacheRead.tokens +
  FAKE_TURN_USAGE.cacheWrite.tokens

const TURN_COST =
  FAKE_TURN_USAGE.input.cost +
  FAKE_TURN_USAGE.output.cost +
  FAKE_TURN_USAGE.cacheRead.cost +
  FAKE_TURN_USAGE.cacheWrite.cost

/** Cents, so a sum of turns is exact rather than a float with a tail. */
function dollars(cents: number): number {
  return Math.round(cents) / 100
}

/** The canned catalog: one of every status kind. */
const CANNED_PROVIDERS: readonly ProviderState[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    methods: ['oauth', 'api-key'],
    status: { kind: 'oauth', detail: 'Claude subscription' }
  },
  { id: 'openai', name: 'OpenAI', methods: ['api-key'], status: { kind: 'api-key' } },
  {
    id: 'google',
    name: 'Google',
    methods: ['api-key'],
    status: { kind: 'env', variable: 'GEMINI_API_KEY' }
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    methods: ['oauth', 'api-key'],
    status: { kind: 'none' }
  },
  { id: 'groq', name: 'Groq', methods: ['api-key'], status: { kind: 'none' } }
]

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

// Two names and one failure, so a single scripted turn exercises a tool
// chain's multi-name counts and its failure marker without a paid call.
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

// Absent, every prompt runs the standard script and no panel exists, which is
// what a test that is not about the panel wants.
export interface FakePanel {
  readonly tools: PanelTools
  /** Absolute paths; nothing below this seam resolves one. */
  readonly exhibits: { readonly buildPlan: string; readonly benchmark: string }
}

// One call the panel script makes. `answer` is the model's, so the fake never
// writes a result text of its own.
interface PanelCall {
  readonly name: PanelToolName
  readonly summary: string
  readonly answer: () => string
}

// Said after a panel turn, so the reply names where the work went rather than
// leaving the chat silent. A closing turn gets its own line below.
const PANEL_SHOWN_DELTAS: readonly string[] = [
  'That is in the context panel now. Nothing was sent anywhere and nothing was paid for it.'
]

const PANEL_CLOSED_DELTAS: readonly string[] = [
  'That is what the context panel says now. Nothing was sent anywhere and nothing was paid for it.'
]

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

// What the script says about a run it was shown, so a shared run is visibly
// answered rather than silently absorbed.
const SHARED_RUN_ANSWER_DELTAS: readonly string[] = [
  'That command output is in the conversation now, and the script read it.'
]

// The one sentence a summarizing jump leaves behind, so the two continue
// actions are told apart without a paid call.
export const FAKE_BRANCH_SUMMARY =
  'Summary of the abandoned branch: the fake adapter summarizes deterministically, in one sentence.'

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

// A tree rather than a list, so a jump genuinely moves where the conversation
// stands and abandons nothing.
interface Entry {
  readonly id: string
  readonly parentId: string | null
  readonly item: TranscriptItem
  /** ISO time the entry joined the conversation. */
  readonly at: string
  label?: string
}

interface Conversation {
  readonly token: string
  readonly workspacePath: string
  readonly entries: Entry[]
  /** Where the conversation stands; `null` means before any entry. */
  leafId: string | null
  /** Monotonic within the conversation, and inside the context window. */
  usedTokens: number
  // How many turns reported usage in this conversation, every branch of it: a
  // jump abandons a path, never the money spent on it.
  usageMessages: number
  /** ISO time of the last thing that happened in it. */
  at: string
  minted: number
}

interface PendingShare {
  readonly run: BashRunShare
  readonly settle: (outcome: 'delivered' | 'dropped') => void
}

interface Bound {
  conversation: Conversation
  model: ModelId
  thinkingLevel: ThinkingLevel
  running?: RunningTurn
  /** π's two queues, oldest first, undelivered only. */
  readonly steering: string[]
  readonly followUp: string[]
  // Bash runs waiting for a delivery point. They are not queued messages: they
  // never appear in queue state and are never handed back to the composer.
  readonly shares: PendingShare[]
}

interface RunningTurn {
  readonly turnId: TurnId
  abandon(reason: 'cancelled' | 'disposed'): void
}

/** The one login this adapter runs at a time, and the prompt it is waiting on. */
interface FakeLogin {
  readonly providerId: string
  readonly method: AuthMethod
  readonly promptId: string
  settle(outcome: 'succeeded' | 'refused' | 'cancelled'): void
}

/** N turns of the canned per-message numbers, summed exactly as π's would be. */
export function scaleUsage(messages: number): SessionUsage {
  const line = (of: { tokens: number; cost: number }): { tokens: number; cost: number } => ({
    tokens: of.tokens * messages,
    cost: dollars(of.cost * messages * 100)
  })
  return {
    messages,
    input: line(FAKE_TURN_USAGE.input),
    output: line(FAKE_TURN_USAGE.output),
    cacheRead: line(FAKE_TURN_USAGE.cacheRead),
    cacheWrite: line(FAKE_TURN_USAGE.cacheWrite),
    totalTokens: TURN_TOKENS * messages,
    totalCost: dollars(TURN_COST * messages * 100)
  }
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

// Spelled out rather than imported: this module loads in the renderer's test
// build too, where `node:path` does not exist.
function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function preferredLevel(preferred: ThinkingLevel | undefined): ThinkingLevel {
  return preferred !== undefined && FAKE_MODEL.thinkingLevels.includes(preferred) ? preferred : 'low'
}

export function createFakeAdapter({
  pauseMs = DEFAULT_PAUSE_MS,
  panel
}: {
  /** Zero runs the script on microtasks. */
  readonly pauseMs?: number
  /** Absent leaves the standard script the answer to every prompt. */
  readonly panel?: FakePanel
} = {}): ConversationAdapter {
  const listeners = new Set<AdapterEventListener>()
  const conversations = new Map<string, Conversation>()
  const sessions = new Map<SessionId, Bound>()
  const seeded = new Set<string>()
  // Credentials last one app run and are written nowhere: a fake login flips a
  // status in memory and no token exists to store.
  const providers = new Map<string, ProviderState>(
    CANNED_PROVIDERS.map((provider) => [provider.id, provider])
  )
  let liveLogin: FakeLogin | undefined
  let minted = 0
  let prompts = 0

  function emit(event: AdapterEvent): void {
    // A copy, so a listener that unsubscribes while being called does not
    // disturb the delivery of that same event to the others.
    for (const listener of [...listeners]) listener(event)
  }

  // The kind is in the token because canned conversations come back identical
  // next launch, so a stale live token has to match nothing rather than them.
  function mintToken(kind: 'canned' | 'live'): string {
    minted += 1
    return `fake-${kind}-${minted}`
  }

  /** Appends as a child of the leaf and advances it, which is how π grows too. */
  function append(conversation: Conversation, item: TranscriptItem): Entry {
    conversation.minted += 1
    const entry: Entry = {
      id: `${conversation.token}-e${conversation.minted}`,
      parentId: conversation.leafId,
      item,
      at: new Date().toISOString()
    }
    conversation.entries.push(entry)
    conversation.leafId = entry.id
    return entry
  }

  function entryOf(conversation: Conversation, id: string): Entry | undefined {
    return conversation.entries.find((entry) => entry.id === id)
  }

  /** Leaf to root, reversed: the path the conversation currently stands on. */
  function pathEntries(conversation: Conversation): readonly Entry[] {
    const path: Entry[] = []
    let at = conversation.leafId
    while (at !== null) {
      const entry = entryOf(conversation, at)
      if (entry === undefined) break
      path.push(entry)
      at = entry.parentId
    }
    return path.reverse()
  }

  function newConversation(
    workspacePath: string,
    items: readonly TranscriptItem[] = [],
    kind: 'canned' | 'live' = 'live'
  ): Conversation {
    const conversation: Conversation = {
      token: mintToken(kind),
      workspacePath,
      entries: [],
      leafId: null,
      usedTokens: 0,
      usageMessages: 0,
      at: new Date().toISOString(),
      minted: 0
    }
    for (const item of items) append(conversation, item)
    conversation.usedTokens = items.reduce(
      (sum, item) => sum + estimateTokens(JSON.stringify(item)),
      0
    )
    conversations.set(conversation.token, conversation)
    return conversation
  }

  function seed(workspacePath: string): void {
    if (seeded.has(workspacePath)) return
    seeded.add(workspacePath)
    for (const canned of CANNED_HISTORY) {
      newConversation(workspacePath, canned.items, 'canned')
    }
  }

  function requireBound(sessionId: SessionId): Bound {
    const bound = sessions.get(sessionId)
    if (bound === undefined) throw new Error('That session is not bound to a conversation.')
    return bound
  }

  // Checked in this order so that `close the panel` is never taken for the
  // plain `panel` trigger.
  function panelScript(
    bound: Bound,
    sessionId: SessionId,
    text: string
  ): readonly PanelCall[] | undefined {
    if (panel === undefined) return undefined
    const { tools, exhibits } = panel
    const asked = text.toLowerCase()
    const { workspacePath } = bound.conversation

    const show = (path: string, title: string): PanelCall => ({
      name: 'panel_show',
      summary: `${fileName(path)} · "${title}"`,
      answer: () => tools.show(sessionId, workspacePath, path, title)
    })
    const close = (id: string): PanelCall => ({
      name: 'panel_close',
      summary: id,
      answer: () => tools.close(sessionId, id)
    })

    if (asked.includes('close the panel')) return [close('all')]
    // Fails with the model's unknown-id text when that tab is not open, which
    // is the scripted failure path.
    if (asked.includes('tidy the panel')) return [close('benchmark')]
    if (asked.includes('panel')) {
      return [
        show(exhibits.buildPlan, 'Build plan'),
        show(exhibits.benchmark, 'Benchmark'),
        { name: 'panel_list', summary: 'open tabs', answer: () => tools.list(sessionId) }
      ]
    }
    return undefined
  }

  function emitQueue(bound: Bound, sessionId: SessionId): void {
    emit({
      type: 'queue_changed',
      sessionId,
      steering: [...bound.steering],
      followUp: [...bound.followUp]
    })
  }

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

  // A run that never reached a delivery point stays local, and its caller is
  // told so rather than left waiting.
  function dropShares(bound: Bound): void {
    const waiting = bound.shares.splice(0, bound.shares.length)
    for (const share of waiting) share.settle('dropped')
  }

  function previewOf(conversation: Conversation): string {
    for (const entry of [...pathEntries(conversation)].reverse()) {
      if (entry.item.kind === 'user') return clip(`you: ${entry.item.text}`)
      if (entry.item.kind === 'assistant') return clip(`agent: ${entry.item.markdown}`)
    }
    return 'an empty conversation'
  }

  // Every branch, not just the preview beside it: a person looking for a
  // sentence they typed expects to find it wherever they left it.
  function searchableText(conversation: Conversation): string {
    return conversation.entries
      .map(({ item }) => {
        if (item.kind === 'user') return item.text
        if (item.kind === 'assistant') return item.markdown
        if (item.kind === 'thinking') return item.text
        if (item.kind === 'tool') return `${item.name} ${item.summary}`
        if (item.kind === 'bashRun') return `${item.command}\n${item.output}`
        return ''
      })
      .join('\n')
      .toLowerCase()
  }

  // User messages are the nodes; everything between them is the dim connective
  // line. Tool calls and thinking never become nodes.
  function treeOf(conversation: Conversation): SessionTree {
    const childrenOf = new Map<string | null, Entry[]>()
    for (const entry of conversation.entries) {
      const siblings = childrenOf.get(entry.parentId)
      if (siblings === undefined) childrenOf.set(entry.parentId, [entry])
      else siblings.push(entry)
    }

    function collect(parentId: string | null): {
      nodes: TreeNode[]
      passed: TranscriptItem[]
    } {
      const nodes: TreeNode[] = []
      const passed: TranscriptItem[] = []
      for (const entry of childrenOf.get(parentId) ?? []) {
        const below = collect(entry.id)
        if (entry.item.kind === 'user') {
          const activity = summarizeActivity(below.passed)
          nodes.push({
            ref: entry.id,
            text: entry.item.text,
            at: entry.at,
            ...(entry.label === undefined ? {} : { label: entry.label }),
            ...(activity === undefined ? {} : { activity }),
            children: below.nodes
          })
          continue
        }
        // Not a node: it belongs to the line above it, and whatever nodes hang
        // below it belong to the level it was found at.
        passed.push(entry.item)
        passed.push(...below.passed)
        nodes.push(...below.nodes)
      }
      return { nodes, passed }
    }

    return {
      roots: collect(null).nodes,
      path: pathEntries(conversation)
        .filter((entry) => entry.item.kind === 'user')
        .map((entry) => entry.id)
    }
  }

  // Every beat is preceded by a pause and followed by an abandonment check, so
  // a cancel lands promptly wherever the script stands.
  function run(
    bound: Bound,
    sessionId: SessionId,
    turnId: TurnId,
    opening: TranscriptItem,
    /** A panel turn instead of the standard script, when one was matched. */
    panelCalls?: readonly PanelCall[]
  ): Promise<void> {
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
    // What opened the turn is in the conversation from the moment it was sent,
    // which is what makes it a node of the tree while the turn is still live.
    append(conversation, opening)
    const pending: TranscriptItem[] = []
    let spoken = ''
    let counted =
      opening.kind === 'user'
        ? opening.text
        : opening.kind === 'bashRun'
          ? `${opening.command}\n${opening.output}`
          : ''

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
      for (const item of pending) append(conversation, item)
      pending.length = 0
      conversation.at = new Date().toISOString()
      conversation.usedTokens = Math.min(
        CONTEXT_WINDOW,
        conversation.usedTokens + estimateTokens(counted)
      )
      bound.running = undefined
      // One usage-bearing message per turn, whichever way the turn ended: a
      // stopped turn was still paid for.
      conversation.usageMessages += 1
      emit(terminal)
      // Reported after the turn, which is when it is genuinely known.
      emit({
        type: 'usage',
        sessionId,
        usedTokens: conversation.usedTokens,
        contextWindow: CONTEXT_WINDOW,
        cost: dollars(conversation.usageMessages * TURN_COST * 100)
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

    // The panel's tools answer at once and stream nothing, so a call is its
    // start and its end, carrying the model's own text as the output.
    async function panelCall(scripted: PanelCall, number: number): Promise<boolean> {
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

      await beat()
      if (stopped !== undefined) return false
      let ok = true
      let output: string
      try {
        output = scripted.answer()
      } catch (cause) {
        // The failure path is the model's own text, which is what a real
        // failed call would carry.
        ok = false
        output = cause instanceof Error ? cause.message : String(cause)
      }
      emit({ type: 'tool_ended', sessionId, turnId, callId, ok, output })
      counted += output
      pending.push({ kind: 'tool', name: scripted.name, summary: scripted.summary, ok, output })
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

    // The same boundary a steering message lands at. The caller learns of the
    // delivery from the promise it is holding.
    async function deliverShares(): Promise<boolean> {
      while (bound.shares.length > 0) {
        await beat()
        if (stopped !== undefined) return false
        const share = bound.shares.shift()
        if (share === undefined) break
        settleSpoken()
        counted += `${share.run.command}\n${share.run.output}`
        pending.push({
          kind: 'bashRun',
          command: share.run.command,
          output: share.run.output,
          ...(share.run.exitCode === undefined ? {} : { exitCode: share.run.exitCode })
        })
        share.settle('delivered')
        if (!(await say(SHARED_RUN_ANSWER_DELTAS))) return false
      }
      return true
    }

    /** Every delivery point in the script: queued messages, then shared runs. */
    async function boundary(): Promise<boolean> {
      if (!(await deliver('steering'))) return false
      return deliverShares()
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
        if (bound.shares.length > 0) {
          // Its own answer, because a run the script was shown is not a
          // message the user steered it with.
          if (!(await deliverShares())) return false
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

    // Every beat is a cancellation point here too, and each call is followed
    // by the same boundary a steering message lands at.
    async function panelTurn(calls: readonly PanelCall[]): Promise<void> {
      let number = 0
      for (const scripted of calls) {
        number += 1
        if (!(await panelCall(scripted, number))) return finish()
        if (!(await boundary())) return finish()
      }
      const closing = calls.at(-1)?.name === 'panel_close' ? PANEL_CLOSED_DELTAS : PANEL_SHOWN_DELTAS
      if (!(await say(closing))) return finish()

      // The same ending the standard script has: no turn is over while a
      // message is still queued behind it.
      for (;;) {
        if (!(await drain())) return finish()
        await beat()
        if (stopped !== undefined) return finish()
        if (bound.steering.length + bound.followUp.length + bound.shares.length === 0) break
      }
      finish()
    }

    async function script(): Promise<void> {
      emit({ type: 'turn_started', sessionId, turnId })

      if (panelCalls !== undefined) return panelTurn(panelCalls)

      if (!(await think())) return finish()

      let number = 0
      for (const scripted of CHAIN) {
        number += 1
        if (!(await call(scripted, number))) return finish()
        // The boundary between two tool calls is where steering lands.
        if (!(await boundary())) return finish()
      }

      if (!(await say(BETWEEN_DELTAS))) return finish()
      if (!(await call(LONE_CALL, number + 1))) return finish()
      if (!(await boundary())) return finish()
      if (!(await say(REPLY_DELTAS))) return finish()

      // The session is still running during this last pause, so the queues are
      // read again and only a beat nothing arrived in ends the turn.
      for (;;) {
        if (!(await drain())) return finish()
        await beat()
        if (stopped !== undefined) return finish()
        if (bound.steering.length + bound.followUp.length + bound.shares.length === 0) break
      }
      finish()
    }

    function finish(): void {
      // A run that was never delivered stays local: nothing fires at a plan
      // the user killed, and nothing is delivered to a turn that is over.
      dropShares(bound)
      if (stopped === 'disposed') {
        // The document that asked is gone, so the turn says nothing more at
        // all, not even a terminal event.
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
        followUp: [],
        shares: []
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
        followUp: [],
        shares: []
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
      return pathEntries(requireBound(sessionId).conversation).map((entry) => entry.item)
    },

    release(sessionId: SessionId): void {
      const bound = sessions.get(sessionId)
      bound?.running?.abandon('disposed')
      if (bound !== undefined) {
        discardQueue(bound)
        dropShares(bound)
      }
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

    async sessionTree(sessionId: SessionId): Promise<SessionTree> {
      return treeOf(requireBound(sessionId).conversation)
    },

    // In place: the leaf moves to the moment before the chosen message was
    // sent, and every abandoned entry stays exactly where it is.
    async jump(
      sessionId: SessionId,
      ref: string,
      summarize: boolean
    ): Promise<{ editorText?: string }> {
      const bound = requireBound(sessionId)
      const { conversation } = bound
      const entry = entryOf(conversation, ref)
      if (entry === undefined) throw new Error('That point is no longer in this conversation.')

      conversation.leafId = entry.parentId
      if (summarize) {
        // π summarizes the branch that was left; this one says the same thing
        // the same way every time, so the two actions are told apart for free.
        append(conversation, { kind: 'assistant', markdown: FAKE_BRANCH_SUMMARY })
      }
      conversation.at = new Date().toISOString()
      return entry.item.kind === 'user' ? { editorText: entry.item.text } : {}
    },

    async setLabel(sessionId: SessionId, ref: string, label?: string): Promise<void> {
      const entry = entryOf(requireBound(sessionId).conversation, ref)
      if (entry === undefined) throw new Error('That point is no longer in this conversation.')
      entry.label = label === undefined || label.trim() === '' ? undefined : label.trim()
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

    async listProviders(): Promise<readonly ProviderState[]> {
      // Reported in the catalog's own order, which is what the settings
      // surface shows.
      return CANNED_PROVIDERS.map(
        (canned) => providers.get(canned.id) ?? canned
      )
    },

    // Two scripts, one per method, both deterministic: an api-key login asks
    // for a secret, an OAuth login opens a browser it never really opens and
    // asks for the pasted code.
    login(providerId: string, method: AuthMethod): Promise<void> {
      if (liveLogin !== undefined) {
        return Promise.reject(
          new Error('A login is already under way. Finish or cancel it first.')
        )
      }
      const provider = providers.get(providerId)
      if (provider === undefined) {
        return Promise.reject(new Error('Crucible does not know that provider.'))
      }

      prompts += 1
      const promptId = `fake-auth-${prompts}`
      const flow: FakeLogin = { providerId, method, promptId, settle: () => {} }

      const finished = new Promise<void>((resolve, reject) => {
        flow.settle = (outcome) => {
          liveLogin = undefined
          if (outcome === 'cancelled') {
            reject(new Error('That login was cancelled.'))
            return
          }
          if (outcome === 'refused') {
            reject(new Error('That did not look like a key. Nothing was saved.'))
            return
          }
          providers.set(providerId, {
            ...provider,
            status:
              method === 'oauth'
                ? { kind: 'oauth', detail: 'the fake flow, no network' }
                : { kind: 'api-key' }
          })
          resolve()
        }
      })
      liveLogin = flow

      if (method === 'oauth') {
        emit({
          type: 'auth_notice',
          notice: {
            kind: 'auth-url',
            message: 'Your browser opened for authorization.',
            url: `https://example.invalid/authorize?provider=${providerId}`
          }
        })
        emit({
          type: 'auth_prompt',
          promptId,
          kind: 'manual-code',
          message: "If it doesn't come back, paste the redirect URL or code here:",
          placeholder: 'https://…/callback?code=…'
        })
      } else {
        emit({
          type: 'auth_prompt',
          promptId,
          kind: 'secret',
          message: `Paste your ${provider.name} API key.`,
          placeholder: 'sk-…'
        })
      }

      return finished
    },

    async answerAuthPrompt(promptId: string, value: string): Promise<void> {
      const flow = liveLogin
      if (flow === undefined || flow.promptId !== promptId) return
      // Any non-empty answer succeeds; an empty one fails display-safely.
      flow.settle(value.trim() === '' ? 'refused' : 'succeeded')
    },

    async cancelLogin(): Promise<void> {
      const flow = liveLogin
      if (flow === undefined) return
      emit({ type: 'auth_prompt_closed', promptId: flow.promptId })
      flow.settle('cancelled')
    },

    async logout(providerId: string): Promise<void> {
      const provider = providers.get(providerId)
      if (provider === undefined) throw new Error('Crucible does not know that provider.')
      providers.set(providerId, { ...provider, status: { kind: 'none' } })
    },

    // Bound or not: an unbound session is found by its own token, exactly as
    // the SDK adapter finds one.
    async sessionUsage(request: UsageRequest): Promise<SessionUsage | undefined> {
      const conversation =
        sessions.get(request.sessionId)?.conversation ??
        (request.token === undefined ? undefined : conversations.get(request.token))
      if (conversation === undefined || conversation.usageMessages === 0) return undefined
      return scaleUsage(conversation.usageMessages)
    },

    prompt(
      sessionId: SessionId,
      turnId: TurnId,
      text: string,
      images?: readonly ImageAttachment[]
    ): Promise<void> {
      const bound = requireBound(sessionId)
      return run(
        bound,
        sessionId,
        turnId,
        {
          kind: 'user',
          text,
          // Only what was genuinely sent is kept, so a restored transcript shows
          // the thumbnails the live one did and no others.
          ...(images === undefined || images.length === 0 ? {} : { images: [...images] })
        },
        panelScript(bound, sessionId, text)
      )
    },

    // Nothing is queued into a session with no live run, so the caller is told
    // and can send the text as a prompt rather than leave it unheard.
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

    // Never in the queue state and never handed back to the composer: a share
    // is either delivered at a boundary or dropped with the turn.
    shareBashRun(
      sessionId: SessionId,
      run: BashRunShare
    ): Promise<'delivered' | 'dropped' | 'idle'> {
      const bound = requireBound(sessionId)
      if (bound.running === undefined) return Promise.resolve('idle')
      return new Promise((resolve) => {
        bound.shares.push({ run, settle: resolve })
      })
    },

    promptBashRun(sessionId: SessionId, turnId: TurnId, share: BashRunShare): Promise<void> {
      const bound = requireBound(sessionId)
      return run(bound, sessionId, turnId, {
        kind: 'bashRun',
        command: share.command,
        output: share.output,
        ...(share.exitCode === undefined ? {} : { exitCode: share.exitCode })
      })
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
        dropShares(bound)
      }
    }
  }
}
