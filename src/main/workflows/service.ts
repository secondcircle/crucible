import { readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { SessionId, TranscriptItem, Unsubscribe } from '../../shared/agent/port'
import type { RunTools } from '../../shared/agent/run-tools'
import { artifactKind, recordNamesPath } from '../../shared/workflows/artifacts'
import { currentNode, runCost, type RunRecord } from '../../shared/workflows/run'
import type {
  ArtifactView,
  MainWorkflowRunService,
  RunsSnapshot,
  ScheduledFireRequest,
  WorkflowRunListener
} from '../../shared/workflows/service'
import type { StartRunRequest, WorkflowEngine } from './engine'
import type { WorkflowLoader } from './loader'
import { scheduledBase } from './scheduled-base'
import { checkoutRootOf, headOf } from './worktree'

// The live service: one engine, fanned out three ways — the IPC channel that
// feeds the run surfaces, the run tools the SDK adapter mounts on every
// composed agent, and the ⌘R toggle main's key interception fires. Every
// rule about what a run is lives in the engine; this module is address
// translation and wording.

/** Changes storm during a turn; one snapshot per beat is plenty. */
const BROADCAST_MS = 150

export interface LiveWorkflowRunOptions {
  readonly engine: WorkflowEngine
  readonly loader: WorkflowLoader
  /** Called when the engine's state changed; wired to engine.onChanged. */
  readonly changes: { subscribe(listener: () => void): void }
  // Where a scheduled fire branches from: the trunk tip, fetched fresh. An
  // argument so the rule is drivable without a repository.
  readonly base?: (workspacePath: string) => Promise<string>
  /** Shows a file in the OS file manager; absent leaves Reveal unable to act. */
  readonly reveal?: (path: string) => void
}

/** Refused with the same sentence whatever was asked for. */
const NOT_THIS_RUNS = 'That file is not one this run touched.'

export function createLiveWorkflowRunService({
  engine,
  loader,
  changes,
  base = scheduledBase,
  reveal
}: LiveWorkflowRunOptions): MainWorkflowRunService {
  const listeners = new Set<WorkflowRunListener>()
  let broadcastTimer: ReturnType<typeof setTimeout> | undefined

  function snapshotNow(): RunsSnapshot {
    return { runs: engine.runs() }
  }

  changes.subscribe(() => {
    if (broadcastTimer !== undefined) return
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined
      const event = { type: 'runs', snapshot: snapshotNow() } as const
      for (const listener of [...listeners]) listener(event)
    }, BROADCAST_MS)
  })

  // A file is reachable through here because the named run's record names it,
  // and for no other reason: the path is a lookup key, never resolved.
  function fileOf(runId: string, path: string): { readonly path: string } | undefined {
    const run = engine.runs().find((candidate) => candidate.id === runId)
    if (run === undefined || !recordNamesPath(run, path)) return undefined
    return { path }
  }

  function gate(runId: string, path: string): void {
    if (fileOf(runId, path) === undefined) throw new Error(NOT_THIS_RUNS)
  }

  // The session's working directory is what the adapter knows; the workspace
  // the run belongs to is that directory's checkout root, which is the same
  // place workspace workflows are discovered.
  async function workspaceRootOf(workingDir: string): Promise<string> {
    try {
      return await checkoutRootOf(workingDir)
    } catch {
      // Not a repository: workflows can still be listed from here, though a
      // run cannot start (it has no commit to branch from).
      return workingDir
    }
  }

  const tools: RunTools = {
    async workflows(workingDir: string): Promise<string> {
      const root = await workspaceRootOf(workingDir)
      const listed = await loader.list(root)
      if (listed.length === 0) {
        return (
          'No workflows are available here — Crucible ships none. A workflow is a ' +
          `TypeScript file in ${join(root, '.crucible', 'workflows')} (workspace) or ` +
          '~/.crucible/workflows (user). To write one, read the workflow authoring page ' +
          'of the agent docs, which names complete shipped examples to copy and adapt.'
        )
      }
      return listed
        .map((workflow) => {
          const inputs = Object.entries(workflow.def.inputs)
            .map(([name, description]) => `${name}: ${description}`)
            .join('; ')
          return `- ${workflow.name} (${workflow.origin}) — ${workflow.def.description}${
            inputs === '' ? '' : `\n  inputs: ${inputs}`
          }`
        })
        .join('\n')
    },

    async start(
      sessionId: SessionId,
      workingDir: string,
      workflow: string,
      inputs: Readonly<Record<string, string>>,
      base?: string
    ): Promise<string> {
      const root = await checkoutRootOf(workingDir).catch(() => {
        throw new Error(
          `${workingDir} is not inside a git repository, so a run has no commit to branch from.`
        )
      })
      const request: StartRunRequest = {
        workspacePath: root,
        workspaceName: basename(root),
        sessionId,
        workflow,
        inputs,
        // The session's own HEAD — the worktree's when it works in one —
        // unless the agent named another commit.
        base: base === undefined || base.trim() === '' ? await headOf(workingDir) : base.trim()
      }
      const run = await engine.start(request)
      return (
        `Run ${run.id} of "${run.workflow}" started · branch ${run.branch} · ` +
        `worktree ${run.worktreePath} · base ${(run.baseCommit ?? '').slice(0, 7)}.\n` +
        'It works unattended and reports back to this session — check-ins, blockers and ' +
        'completion all arrive here as messages. Ending your turn now is the normal thing to do.'
      )
    },

    async list(sessionId: SessionId): Promise<string> {
      const runs = engine.runs().filter((run) => run.sessionId === sessionId)
      if (runs.length === 0) return 'This session has no workflow runs.'
      return runs.map(describeRun).join('\n')
    },

    async answer(_sessionId: SessionId, runId: string, message: string): Promise<string> {
      engine.answer(runId, message)
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

    async pause(runId: string): Promise<void> {
      engine.pause(runId)
    },

    async resume(runId: string): Promise<void> {
      engine.resume(runId)
    },

    async cancel(runId: string): Promise<void> {
      engine.cancel(runId)
    },

    async dismiss(runId: string): Promise<void> {
      engine.dismiss(runId)
    },

    async adopt(runId: string, sessionId: SessionId): Promise<void> {
      engine.adopt(runId, sessionId)
    },

    async nodeTranscript(runId: string, nodeId: string): Promise<readonly TranscriptItem[]> {
      return engine.nodeTranscript(runId, nodeId)
    },

    async artifact(runId: string, path: string): Promise<ArtifactView> {
      gate(runId, path)
      const kind = artifactKind(path)
      let bytes: number
      let modifiedAt: string | undefined
      try {
        const stat = statSync(path)
        bytes = stat.size
        modifiedAt = stat.mtime.toISOString()
      } catch {
        throw new Error(`That artifact could not be read: ${basename(path)}.`)
      }
      if (kind === 'html') {
        return { kind, bytes, ...(modifiedAt === undefined ? {} : { modifiedAt }) }
      }
      try {
        return {
          kind,
          body: readFileSync(path, 'utf8'),
          bytes,
          ...(modifiedAt === undefined ? {} : { modifiedAt })
        }
      } catch {
        throw new Error(`That artifact could not be read: ${basename(path)}.`)
      }
    },

    async revealArtifact(runId: string, path: string): Promise<void> {
      gate(runId, path)
      if (reveal === undefined) throw new Error('This launch cannot open a file manager.')
      reveal(path)
    },

    tools,

    // The whole of what a scheduled fire is beyond an ordinary run: the trunk
    // for a base, nothing handed in, nobody to report to, and the marker that
    // puts it on the schedule board.
    async startScheduled(fire: ScheduledFireRequest) {
      return engine.start({
        workspacePath: fire.workspacePath,
        workspaceName: basename(fire.workspacePath),
        workflow: fire.workflow,
        inputs: {},
        base: await base(fire.workspacePath),
        scheduled: true
      })
    },

    toggleOverview(): void {
      for (const listener of [...listeners]) listener({ type: 'toggle-overview' })
    },

    artifactFile: fileOf,

    dispose(): void {
      if (broadcastTimer !== undefined) clearTimeout(broadcastTimer)
      listeners.clear()
      engine.dispose()
    }
  }
}

function describeRun(run: RunRecord): string {
  const node = currentNode(run)
  const cost = runCost(run)
  const parts = [
    `run ${run.id} (${run.workflow}) — ${run.status}`,
    node === undefined ? undefined : `node ${node.id} ${node.status}`,
    cost === undefined ? undefined : `$${cost.toFixed(2)}`,
    run.branch,
    run.waiting === true && run.question !== undefined
      ? `⚑ waiting on an answer: ${run.question.reason.split('\n')[0]}`
      : undefined
  ]
  return `- ${parts.filter((part): part is string => part !== undefined).join(' · ')}`
}
