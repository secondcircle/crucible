import type { SessionId, TranscriptItem, Unsubscribe } from '../agent/port'
import type { RunTools } from '../agent/run-tools'
import { artifactKind, artifactName, recordNamesPath } from './artifacts'
import {
  runMessageHeader,
  type RunArtifact,
  type RunNode,
  type RunRecord,
  type WorkflowRunId
} from './run'
import type {
  ArtifactView,
  MainWorkflowRunService,
  RunsSnapshot,
  WorkflowRunListener
} from './service'

// The fake flavor's runs: scripted, deterministic, free. A `crucible_run`
// tool call starts a run that walks its nodes on a timer, parks once when
// the workflow is `build` (so the routed-question surfaces are exercisable),
// and completes with the same message-to-the-orchestrator the engine sends.
// Two canned records seed the global view, so ⌘R shows cross-workspace
// grouping without anything having been started.
//
// Scripted nodes declare the artifacts they will write and then write them,
// so the artifact rail, the reader and the exhibit-run route are all
// exercised under `npm run dev`.

const CANNED_WORKSPACE = { path: '/fake/resume-site', name: 'resume-site' }

/** Slow enough to watch under `npm run dev`; tests pass zero. */
const DEFAULT_BEAT_MS = 700

const FAKE_QUESTION =
  'Third review round on the same argument — where should the merge helper live? ' +
  'The spec is silent and the reviewers disagree.'

// This module is compiled into the renderer bundle too, so it takes no
// `node:` import: main hands it the file access, and a test hands it a map.
export interface FakeArtifactFiles {
  /** The run's artifact directory, created on first ask. */
  dir(runId: WorkflowRunId): string
  write(path: string, body: string): void
  /** The file's text, or nothing when there is no file. */
  read(path: string): string | undefined
  /** Size in bytes, or nothing when there is no file. */
  size(path: string): number | undefined
}

/** What a test hands in: the same capability with nothing on disk. */
export function memoryArtifactFiles(
  root = '/fake/state/workflow-runs'
): FakeArtifactFiles & { readonly written: Map<string, string> } {
  const written = new Map<string, string>()
  return {
    written,
    dir: (runId) => `${root}/${runId}/artifacts`,
    write: (path, body) => {
      written.set(path, body)
    },
    read: (path) => written.get(path),
    size: (path) => {
      const body = written.get(path)
      return body === undefined ? undefined : body.length
    }
  }
}

interface LiveNode {
  id: string
  status: RunNode['status']
  parents: string[]
  model?: string
  reads: RunArtifact[]
  artifacts: RunArtifact[]
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
  inputDescs?: Record<string, string>
  question?: { reason: string; nodeId?: string; raisedAt: string; answeredAt?: string; answer?: string }
  waiting?: boolean
  nodes: LiveNode[]
  outputs?: Record<string, unknown>
  error?: string
  createdAt: string
  startedAt?: string
  endedAt?: string
}

/** One output of a scripted node: what it declares, and what it writes. */
interface ScriptedOutput {
  readonly name: string
  readonly file: string
  readonly desc: string
  readonly body: string
}

interface ScriptedNode {
  readonly id: string
  readonly parents: readonly string[]
  readonly model: string
  // Whether the plan already knows about the outputs. A planned node shows its
  // expected artifacts as a ghost; the rest declare theirs when they start.
  readonly planned: boolean
  readonly outputs: readonly ScriptedOutput[]
  /** Input names this node reads, then artifact files of earlier nodes. */
  readonly readsInputs: readonly string[]
  readonly readsFiles: readonly string[]
}

const SPEC_BODY = `# Spec — the scripted build

The planner's product: what the builder implements and the reviewer judges.

## What done means

- The rail lists every artifact this run touched, inputs first.
- Clicking one opens it here, in place of the node transcript.
- Nothing in the view writes, deletes or re-runs anything.
`

const CHANGES_BODY = `# Changes

- \`src/renderer/src/components/ArtifactRail.tsx\` — the run view's third column.
- \`src/renderer/src/components/ArtifactReader.tsx\` — one artifact, rendered.
- \`src/main/workflows/engine.ts\` — declared outputs recorded at node start.
`

const REVIEW_BODY = `# Review — approved

The branch does what the spec asked. Two notes, neither blocking:

1. The rail's count reads artifacts, not nodes, which is what the mock draws.
2. A failed node keeps its row, marked never written.
`

const REPORT_BODY = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Scripted run report</title>
<style>
  body{background:#191419;color:#e8dfe2;font:14px/1.6 -apple-system,sans-serif;padding:28px}
  h1{font-size:17px;color:#f0a37c;margin:0 0 12px}
  li{margin-bottom:6px}
  code{font:12px ui-monospace,Menlo,monospace;color:#f0a37c}
</style></head>
<body>
  <h1>What this scripted run did</h1>
  <p>Nothing was sent anywhere and nothing cost money. This page is an
  artifact of the fake flavor, served under its own origin.</p>
  <ul>
    <li>Walked its nodes on a timer.</li>
    <li>Wrote every artifact it declared, <code>report.html</code> included.</li>
    <li>Reported back to the session that started it.</li>
  </ul>
</body></html>
`

/** What a canned run's artifacts hold, by file name. */
const CANNED_BODIES: Readonly<Record<string, string>> = {
  'spec.md': SPEC_BODY,
  'changes.md': CHANGES_BODY,
  'review.md': REVIEW_BODY,
  'report.html': REPORT_BODY
}

const CANNED_BODY = 'A canned artifact of the fake flavor.\n'

/** The scripted graph of a workflow: what its nodes read, declare and write. */
function scriptOf(workflow: string): readonly ScriptedNode[] {
  if (workflow !== 'build') {
    return [
      {
        id: 'work',
        parents: [],
        model: 'anthropic/claude-opus-5:high',
        planned: true,
        outputs: [
          {
            name: 'report',
            file: 'report.html',
            desc: "the node's report of what it did and why, for the human",
            body: REPORT_BODY
          }
        ],
        readsInputs: ['prompt'],
        readsFiles: []
      }
    ]
  }
  return [
    {
      id: 'planner',
      parents: [],
      model: 'anthropic/claude-fable-5:high',
      planned: true,
      outputs: [
        {
          name: 'spec',
          file: 'spec.md',
          desc: 'the Spec: what to build, derived from the intent document',
          body: SPEC_BODY
        }
      ],
      readsInputs: ['intent'],
      readsFiles: []
    },
    {
      id: 'builder',
      parents: ['planner'],
      model: 'anthropic/claude-opus-5:high',
      planned: false,
      outputs: [
        {
          name: 'changes',
          file: 'changes.md',
          desc: 'every file the builder touched, with reasons',
          body: CHANGES_BODY
        }
      ],
      readsInputs: ['intent'],
      readsFiles: ['spec.md']
    },
    {
      id: 'review-1',
      parents: ['builder'],
      model: 'anthropic/claude-fable-5:high',
      planned: true,
      outputs: [
        {
          name: 'review',
          file: 'review.md',
          desc: "the reviewer's verdict and its evidence",
          body: REVIEW_BODY
        }
      ],
      readsInputs: [],
      readsFiles: ['spec.md', 'changes.md']
    }
  ]
}

export interface FakeWorkflowRunOptions {
  /** Zero advances the script on immediate timers. */
  readonly beatMs?: number
  /** How a run speaks to its orchestrator; absent leaves runs silent. */
  readonly deliver?: (sessionId: SessionId, text: string) => void
  // Where scripted artifacts are written and read. Absent keeps the records
  // right and leaves `artifact()` with nothing to answer from.
  readonly files?: FakeArtifactFiles
  /** Shows a file in the OS file manager; absent leaves Reveal unable to act. */
  readonly reveal?: (path: string) => void
}

export function createFakeWorkflowRunService({
  beatMs = DEFAULT_BEAT_MS,
  deliver,
  files,
  reveal
}: FakeWorkflowRunOptions = {}): MainWorkflowRunService {
  const listeners = new Set<WorkflowRunListener>()
  const timers = new Map<WorkflowRunId, ReturnType<typeof setTimeout>>()
  const waiting = new Map<WorkflowRunId, (answer: string) => void>()
  const paused = new Set<WorkflowRunId>()
  let minted = 0

  const nowIso = (): string => new Date().toISOString()

  const artifactDir = (runId: WorkflowRunId): string =>
    files?.dir(runId) ?? `/fake/state/workflow-runs/${runId}/artifacts`

  const records: LiveRun[] = [cannedUnattended(artifactDir), cannedFinished(artifactDir)]
  // The canned runs' files exist from the moment the service does, so opening
  // one in the reader shows real content without anything having been started.
  for (const run of records) {
    for (const node of run.nodes) {
      for (const artifact of node.artifacts) {
        if (artifact.writtenAt === undefined) continue
        files?.write(artifact.path, CANNED_BODIES[artifactName(artifact.path)] ?? CANNED_BODY)
      }
    }
  }

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
    const script = scriptOf(run.workflow).find((candidate) => candidate.id === node.id)
    const dir = artifactDir(run.id)
    node.status = 'running'
    node.startedAt = nowIso()
    node.lastActivityAt = nowIso()
    node.now = 'running bash…'
    node.toolCalls = 0
    // What the node takes and what it will make, both known the moment it
    // starts: the rail fills its slots from here.
    node.reads = (script?.readsInputs ?? [])
      .map((name) => run.inputs[name])
      .filter((path): path is string => path !== undefined)
      .map((path) => ({ name: artifactName(path), path, desc: 'input' }))
      .concat(
        (script?.readsFiles ?? []).map((file) => ({
          name: file,
          path: `${dir}/${file}`,
          desc: 'input'
        }))
      )
    node.artifacts = (script?.outputs ?? []).map((output) => ({
      name: output.name,
      path: `${dir}/${output.file}`,
      desc: output.desc
    }))
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
        // The declared files land at the beat the node completes, and the
        // record stamps them written, exactly as the engine does.
        node.artifacts = node.artifacts.map((artifact, at) => {
          const body = script?.outputs[at]?.body ?? ''
          files?.write(artifact.path, body)
          return { ...artifact, writtenAt: nowIso() }
        })
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

  // A file is reachable through here because the named run's record names it,
  // and for no other reason.
  function fileOf(runId: WorkflowRunId, path: string): { readonly path: string } | undefined {
    const run = records.find((candidate) => candidate.id === runId)
    if (run === undefined || !recordNamesPath(run as RunRecord, path)) return undefined
    return { path }
  }

  function gate(runId: WorkflowRunId, path: string): void {
    if (fileOf(runId, path) === undefined) {
      throw new Error('That file is not one this run touched.')
    }
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
      const dir = artifactDir(id)
      const nodes: LiveNode[] = scriptOf(workflow).map((script) => ({
        id: script.id,
        status: 'pending',
        parents: [...script.parents],
        model: script.model,
        reads: [],
        artifacts: script.planned
          ? script.outputs.map((output) => ({
              name: output.name,
              path: `${dir}/${output.file}`,
              desc: output.desc
            }))
          : []
      }))
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
        inputDescs: describeInputs(workflow, inputs),
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

    async artifact(runId: WorkflowRunId, path: string): Promise<ArtifactView> {
      gate(runId, path)
      const body = files?.read(path)
      if (body === undefined) {
        throw new Error(`That artifact could not be read: ${artifactName(path)}.`)
      }
      const kind = artifactKind(path)
      const bytes = files?.size(path) ?? body.length
      return kind === 'html' ? { kind, bytes } : { kind, body, bytes }
    },

    async revealArtifact(runId: WorkflowRunId, path: string): Promise<void> {
      gate(runId, path)
      if (reveal === undefined) throw new Error('This launch cannot open a file manager.')
      reveal(path)
    },

    tools,

    toggleOverview(): void {
      for (const listener of [...listeners]) listener({ type: 'toggle-overview' })
    },

    artifactFile: fileOf,

    dispose(): void {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      listeners.clear()
    }
  }
}

function describeInputs(
  workflow: string,
  inputs: Readonly<Record<string, string>>
): Record<string, string> {
  const known: Record<string, string> = {
    intent: 'The intent document for the work.',
    prompt: "A file containing the node's task, used verbatim."
  }
  return Object.fromEntries(
    Object.keys(inputs).map((name) => [name, known[name] ?? `An input of the "${workflow}" run.`])
  )
}

function lastSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString()
}

/** A finished run in another workspace, so the global view has grouping. */
function cannedFinished(artifactDir: (runId: WorkflowRunId) => string): LiveRun {
  const dir = artifactDir('d3p8')
  const intent = `${CANNED_WORKSPACE.path}/docs/intent/og-images.md`
  const read = (path: string): RunArtifact => ({ name: artifactName(path), path, desc: 'input' })
  const spec = `${dir}/spec.md`
  const changes = `${dir}/changes.md`
  const review = `${dir}/review.md`
  const report = `${dir}/report.html`
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
    inputs: { intent },
    inputDescs: { intent: 'The intent document for the work.' },
    nodes: [
      {
        id: 'planner',
        status: 'complete',
        parents: [],
        model: 'anthropic/claude-fable-5:high',
        reads: [read(intent)],
        artifacts: [
          {
            name: 'spec',
            path: spec,
            desc: 'the Spec: what to build, derived from the intent document',
            writtenAt: hoursAgo(3.8)
          }
        ],
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
        reads: [read(intent), read(spec)],
        artifacts: [
          {
            name: 'changes',
            path: changes,
            desc: 'every file the builder touched, with reasons',
            writtenAt: hoursAgo(2.4)
          }
        ],
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
        reads: [read(spec), read(changes)],
        artifacts: [
          {
            name: 'review',
            path: review,
            desc: "the reviewer's verdict and its evidence",
            writtenAt: hoursAgo(2.1)
          }
        ],
        summary: 'Approved.',
        verdict: { verdict: 'approved', reason: 'matches the spec' },
        cost: 0.42,
        toolCalls: 9,
        startedAt: hoursAgo(2.4),
        endedAt: hoursAgo(2.1)
      },
      {
        id: 'report',
        status: 'complete',
        parents: ['review-1'],
        model: 'anthropic/claude-fable-5:high',
        reads: [read(review)],
        artifacts: [
          {
            name: 'report',
            path: report,
            desc: "the run's summary for the human",
            writtenAt: hoursAgo(2)
          }
        ],
        summary: 'Wrote the report.',
        cost: 0.18,
        toolCalls: 4,
        startedAt: hoursAgo(2.1),
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
function cannedUnattended(artifactDir: (runId: WorkflowRunId) => string): LiveRun {
  const dir = artifactDir('g8x2')
  const intent = `${CANNED_WORKSPACE.path}/docs/intent/quota-flicker.md`
  const spec = `${dir}/spec.md`
  return {
    id: 'g8x2',
    workflow: 'build',
    status: 'running',
    workspacePath: CANNED_WORKSPACE.path,
    workspaceName: CANNED_WORKSPACE.name,
    worktreePath: `${CANNED_WORKSPACE.path}/.crucible/worktrees/run-g8x2`,
    branch: 'crucible/run-g8x2',
    baseCommit: 'c4rl0fake',
    inputs: { intent },
    inputDescs: { intent: 'The intent document for the work.' },
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
        reads: [{ name: artifactName(intent), path: intent, desc: 'input' }],
        artifacts: [
          {
            name: 'spec',
            path: spec,
            desc: 'the Spec: what to build, derived from the intent document',
            writtenAt: hoursAgo(1)
          }
        ],
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
        reads: [
          { name: artifactName(intent), path: intent, desc: 'input' },
          { name: 'spec.md', path: spec, desc: 'input' }
        ],
        // Declared and not written: what an expected artifact looks like while
        // the node that owes it is parked.
        artifacts: [
          {
            name: 'changes',
            path: `${dir}/changes.md`,
            desc: 'every file the builder touched, with reasons'
          }
        ],
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
