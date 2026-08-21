import type { SessionId, TranscriptItem, Unsubscribe } from '../agent/port'
import type { RunTools } from '../agent/run-tools'
import { runMessageHeader, type RunNode, type RunRecord, type WorkflowRunId } from './run'
import type {
  MainWorkflowRunService,
  RunsSnapshot,
  WorkflowRunListener
} from './service'

// The fake flavor's runs: scripted, deterministic, free. A `crucible_run`
// tool call starts a run that walks its nodes on a timer, parks once when
// the workflow is `build` (so the routed-question surfaces are exercisable),
// and completes with the same message-to-the-orchestrator the engine sends.
// Two canned records seed the global view — one waiting on a person, one
// finished — so ⌘R shows its bands without anything having been started.

const CANNED_WORKSPACE = { path: '/fake/resume-site', name: 'resume-site' }

/** Slow enough to watch under `npm run dev`; tests pass zero. */
const DEFAULT_BEAT_MS = 700

const FAKE_QUESTION =
  'Third review round on the same argument — where should the merge helper live? ' +
  'The spec is silent and the reviewers disagree.'

interface LiveNode {
  id: string
  status: RunNode['status']
  parents: string[]
  model?: string
  reads: RunNode['reads']
  artifacts: RunNode['artifacts']
  verdict?: unknown
  summary?: string
  startedAt?: string
  endedAt?: string
  lastActivityAt?: string
  now?: string
  toolCalls?: number
  contextPercent?: number
  cost?: number
}

interface LiveRun {
  id: WorkflowRunId
  workflow: string
  status: RunRecord['status']
  workspacePath: string
  workspaceName: string
  sessionId?: SessionId
  worktreePath?: string
  branch?: string
  baseCommit?: string
  finalCommit?: string
  inputs: Record<string, string>
  question?: { reason: string; nodeId?: string; raisedAt: string; answeredAt?: string; answer?: string }
  waiting?: boolean
  nodes: LiveNode[]
  outputs?: Record<string, unknown>
  error?: string
  createdAt: string
  startedAt?: string
  endedAt?: string
}

export interface FakeWorkflowRunOptions {
  /** Zero advances the script on immediate timers. */
  readonly beatMs?: number
  /** How a run speaks to its orchestrator; absent leaves runs silent. */
  readonly deliver?: (sessionId: SessionId, text: string) => void
}

export function createFakeWorkflowRunService({
  beatMs = DEFAULT_BEAT_MS,
  deliver
}: FakeWorkflowRunOptions = {}): MainWorkflowRunService {
  const listeners = new Set<WorkflowRunListener>()
  const records: LiveRun[] = [cannedUnattended(), cannedFinished()]
  const timers = new Map<WorkflowRunId, ReturnType<typeof setTimeout>>()
  const waiting = new Map<WorkflowRunId, (answer: string) => void>()
  const paused = new Set<WorkflowRunId>()
  let minted = 0

  const nowIso = (): string => new Date().toISOString()

  function changed(): void {
    const event = { type: 'runs', snapshot: snapshotNow() } as const
    for (const listener of [...listeners]) listener(event)
  }

  function snapshotNow(): RunsSnapshot {
    return { runs: records as readonly RunRecord[] }
  }

  function tell(run: LiveRun, text: string): void {
    if (run.sessionId === undefined) return
    deliver?.(run.sessionId, text)
  }

  function requireRun(runId: WorkflowRunId): LiveRun {
    const found = records.find((candidate) => candidate.id === runId)
    if (found === undefined) throw new Error(`No run is named "${runId}".`)
    return found
  }

  /** One beat later — unless the run is paused, in which case wait it out. */
  function beat(run: LiveRun, then: () => void): void {
    const tick = (): void => {
      if (run.status === 'cancelled') return
      if (paused.has(run.id)) {
        timers.set(run.id, setTimeout(tick, Math.max(beatMs, 10)))
        return
      }
      then()
    }
    timers.set(run.id, setTimeout(tick, beatMs))
  }

  function startNode(run: LiveRun, index: number, cost: number): void {
    const node = run.nodes[index]
    if (node === undefined) {
      finish(run)
      return
    }
    node.status = 'running'
    node.startedAt = nowIso()
    node.lastActivityAt = nowIso()
    node.now = 'running bash…'
    node.toolCalls = 0
    changed()
    beat(run, () => {
      node.toolCalls = 7
      node.contextPercent = 14 + index * 8
      node.cost = cost
      node.lastActivityAt = nowIso()
      node.now = 'writing response…'
      changed()
      beat(run, () => {
        node.status = 'complete'
        node.endedAt = nowIso()
        delete node.now
        node.summary = `Scripted completion of ${node.id}; nothing was sent anywhere.`
        if (node.id.includes('review')) {
          node.verdict = { verdict: 'approved', reason: 'the scripted diff holds up' }
        }
        changed()

        // The build script parks once after its builder node: the question
        // routes to the orchestrator, exactly as the engine would.
        if (run.workflow === 'build' && node.id === 'builder') {
          run.question = { reason: FAKE_QUESTION, nodeId: node.id, raisedAt: nowIso() }
          run.waiting = true
          const next = run.nodes[index + 1]
          if (next !== undefined) next.status = 'blocked'
          changed()
          tell(
            run,
            `${runMessageHeader(run)} is checking in:\n\n${FAKE_QUESTION}\n\n` +
              `Answer with the crucible_answer tool (runId "${run.id}").`
          )
          waiting.set(run.id, (answer) => {
            waiting.delete(run.id)
            run.waiting = false
            if (run.question !== undefined) {
              run.question.answeredAt = nowIso()
              run.question.answer = answer
            }
            if (next !== undefined) next.status = 'pending'
            changed()
            startNode(run, index + 1, cost + 0.31)
          })
          return
        }

        startNode(run, index + 1, cost + 0.31)
      })
    })
  }

  function finish(run: LiveRun): void {
    run.status = 'complete'
    run.endedAt = nowIso()
    run.finalCommit = 'f4kec0mm17'
    run.outputs = { summary: 'the scripted run finished; nothing was sent anywhere' }
    changed()
    tell(
      run,
      `${runMessageHeader(run)} completed · branch ${run.branch} · ` +
        `worktree ${run.worktreePath}.\n\nIts work is committed on that branch — pull it in ` +
        'when you judge the moment right. Tell the user what came back.'
    )
  }

  const tools: RunTools = {
    async workflows(): Promise<string> {
      return [
        '- adhoc (built-in) — one node running a prompt file, in a worktree',
        '  inputs: prompt: A file containing the node\'s task, used verbatim.',
        '- build (built-in) — take an intent document to built code: a Spec, a builder, and a review loop',
        '  inputs: intent: The intent document for the work.'
      ].join('\n')
    },

    async start(
      sessionId: SessionId,
      workingDir: string,
      workflow: string,
      inputs: Readonly<Record<string, string>>
    ): Promise<string> {
      minted += 1
      const id = `fk${minted}${Math.floor(Math.random() * 90 + 10)}`
      const nodes: LiveNode[] =
        workflow === 'build'
          ? [
              ghost('planner', [], 'anthropic/claude-fable-5:high'),
              ghost('builder', ['planner'], 'anthropic/claude-opus-5:high'),
              ghost('review-1', ['builder'], 'anthropic/claude-fable-5:high')
            ]
          : [ghost('work', [], 'anthropic/claude-opus-5:high')]
      const run: LiveRun = {
        id,
        workflow,
        status: 'running',
        workspacePath: workingDir,
        workspaceName: lastSegment(workingDir),
        sessionId,
        worktreePath: `${workingDir}/.crucible/worktrees/run-${id}`,
        branch: `crucible/run-${id}`,
        baseCommit: '6c90bb0fake',
        inputs: { ...inputs },
        nodes,
        createdAt: nowIso(),
        startedAt: nowIso()
      }
      records.unshift(run)
      changed()
      startNode(run, 0, 0.61)
      return (
        `Run ${id} of "${workflow}" started · branch ${run.branch} · worktree ` +
        `${run.worktreePath} · base 6c90bb0.\nIt works unattended and reports back to this ` +
        'session. Ending your turn now is the normal thing to do. (Scripted: no cost.)'
      )
    },

    async list(sessionId: SessionId): Promise<string> {
      const mine = records.filter((run) => run.sessionId === sessionId)
      if (mine.length === 0) return 'This session has no workflow runs.'
      return mine
        .map(
          (run) =>
            `- run ${run.id} (${run.workflow}) — ${run.status}` +
            (run.waiting === true ? ' · ⚑ waiting on an answer' : '')
        )
        .join('\n')
    },

    async answer(_sessionId: SessionId, runId: string, message: string): Promise<string> {
      const resume = waiting.get(runId)
      if (resume === undefined) throw new Error(`The run "${runId}" is not waiting on an answer.`)
      resume(message)
      return `Answer delivered to run ${runId}; it resumes from here.`
    }
  }

  return {
    async snapshot(): Promise<RunsSnapshot> {
      return snapshotNow()
    },

    onEvent(listener: WorkflowRunListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async pause(runId: WorkflowRunId): Promise<void> {
      const run = requireRun(runId)
      if (run.status !== 'running') return
      paused.add(runId)
      run.status = 'paused'
      changed()
    },

    async resume(runId: WorkflowRunId): Promise<void> {
      const run = requireRun(runId)
      if (run.status !== 'paused') return
      paused.delete(runId)
      run.status = 'running'
      changed()
    },

    async cancel(runId: WorkflowRunId): Promise<void> {
      const run = requireRun(runId)
      if (run.status !== 'running' && run.status !== 'paused') return
      run.status = 'cancelled'
      run.endedAt = nowIso()
      paused.delete(runId)
      waiting.delete(runId)
      const timer = timers.get(runId)
      if (timer !== undefined) clearTimeout(timer)
      for (const node of run.nodes) {
        if (node.status === 'running' || node.status === 'blocked') {
          node.status = 'failed'
          node.endedAt = nowIso()
          delete node.now
        }
      }
      changed()
    },

    async nodeTranscript(): Promise<readonly TranscriptItem[]> {
      return CANNED_NODE_TRANSCRIPT
    },

    tools,

    toggleOverview(): void {
      for (const listener of [...listeners]) listener({ type: 'toggle-overview' })
    },

    dispose(): void {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      listeners.clear()
    }
  }
}

function ghost(id: string, parents: string[], model: string): LiveNode {
  return { id, status: 'pending', parents, model, reads: [], artifacts: [] }
}

function lastSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString()
}

/** A finished run in another workspace, so the global view has grouping. */
function cannedFinished(): LiveRun {
  return {
    id: 'd3p8',
    workflow: 'build',
    status: 'complete',
    workspacePath: CANNED_WORKSPACE.path,
    workspaceName: CANNED_WORKSPACE.name,
    worktreePath: `${CANNED_WORKSPACE.path}/.crucible/worktrees/run-d3p8`,
    branch: 'crucible/run-d3p8',
    baseCommit: 'a11ce0fake',
    finalCommit: 'b0bfake',
    inputs: { intent: `${CANNED_WORKSPACE.path}/docs/intent/og-images.md` },
    nodes: [
      {
        id: 'planner',
        status: 'complete',
        parents: [],
        model: 'anthropic/claude-fable-5:high',
        reads: [],
        artifacts: [],
        summary: 'Wrote the spec.',
        cost: 0.61,
        toolCalls: 12,
        startedAt: hoursAgo(4),
        endedAt: hoursAgo(3.8)
      },
      {
        id: 'builder',
        status: 'complete',
        parents: ['planner'],
        model: 'anthropic/claude-opus-5:high',
        reads: [],
        artifacts: [],
        summary: 'Built the pipeline.',
        cost: 4.87,
        toolCalls: 41,
        startedAt: hoursAgo(3.8),
        endedAt: hoursAgo(2.4)
      },
      {
        id: 'review-1',
        status: 'complete',
        parents: ['builder'],
        model: 'anthropic/claude-fable-5:high',
        reads: [],
        artifacts: [],
        summary: 'Approved.',
        verdict: { verdict: 'approved', reason: 'matches the spec' },
        cost: 0.42,
        toolCalls: 9,
        startedAt: hoursAgo(2.4),
        endedAt: hoursAgo(2)
      }
    ],
    outputs: { verdict: 'approved' },
    createdAt: hoursAgo(4),
    startedAt: hoursAgo(4),
    endedAt: hoursAgo(2)
  }
}

/** A session-less parked run: the future unattended kind, seeding ⌘R's
 *  "Start session" state without any unattended machinery existing. */
function cannedUnattended(): LiveRun {
  return {
    id: 'g8x2',
    workflow: 'build',
    status: 'running',
    workspacePath: CANNED_WORKSPACE.path,
    workspaceName: CANNED_WORKSPACE.name,
    worktreePath: `${CANNED_WORKSPACE.path}/.crucible/worktrees/run-g8x2`,
    branch: 'crucible/run-g8x2',
    baseCommit: 'c4rl0fake',
    inputs: { intent: `${CANNED_WORKSPACE.path}/docs/intent/quota-flicker.md` },
    question: {
      reason: 'check-in: no one to ask — the run has no orchestrator session',
      nodeId: 'builder',
      raisedAt: hoursAgo(0.7)
    },
    waiting: true,
    nodes: [
      {
        id: 'planner',
        status: 'complete',
        parents: [],
        model: 'anthropic/claude-fable-5:high',
        reads: [],
        artifacts: [],
        summary: 'Wrote the spec.',
        cost: 0.55,
        toolCalls: 10,
        startedAt: hoursAgo(1.2),
        endedAt: hoursAgo(1)
      },
      {
        id: 'builder',
        status: 'blocked',
        parents: ['planner'],
        model: 'anthropic/claude-opus-5:high',
        reads: [],
        artifacts: [],
        cost: 1.5,
        toolCalls: 22,
        startedAt: hoursAgo(1),
        lastActivityAt: hoursAgo(0.7)
      }
    ],
    createdAt: hoursAgo(1.2),
    startedAt: hoursAgo(1.2)
  }
}

/** What a node dig shows in the fake flavor: the chat pane's own shapes. */
const CANNED_NODE_TRANSCRIPT: readonly TranscriptItem[] = [
  {
    kind: 'thinking',
    text: 'The spec pins the handoff to the agent port; checking the channel tests cover the reconnect path before anything else.',
    seconds: 4
  },
  { kind: 'tool', name: 'bash', summary: 'npm test', ok: true, output: 'Tests 42 passed (42)\n' },
  {
    kind: 'tool',
    name: 'read',
    summary: 'src/shared/agent/port.ts',
    ok: true,
    output: '// This module imports nothing on purpose\n'
  },
  {
    kind: 'assistant',
    markdown:
      'Reconnect is covered. The preload surface matches the spec\u2019s boundary list; writing the review now.'
  }
]
