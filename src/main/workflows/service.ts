import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { SessionId, TranscriptItem, Unsubscribe } from '../../shared/agent/port'
import type { RunKickoff, RunTools } from '../../shared/agent/run-tools'
import { artifactKind, recordNamesPath } from '../../shared/workflows/artifacts'
import type { ResumeKind } from '../../shared/workflows/run'
import { createTurnStart, describeRun, resumeAnswer } from '../../shared/workflows/status'
import type {
  ArtifactView,
  MainWorkflowRunService,
  RunsSnapshot,
  ScheduledFireRequest,
  WorkflowRunListener
} from '../../shared/workflows/service'
import type { TargetDeclaration } from './authoring'
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
  // Where a scheduled fire branches from: the trunk tip of the run's target
  // repository, fetched fresh. An argument so the rule is drivable without a
  // repository.
  readonly base?: (repositoryPath: string) => Promise<string>
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
          const inputs = Object.entries(workflow.manifest.inputs)
            .map(([name, description]) => `${name}: ${description}`)
            .join('; ')
          return `- ${workflow.name} (${workflow.origin}) — ${workflow.manifest.description}${
            inputs === '' ? '' : `\n  inputs: ${inputs}`
          }${targetLine(workflow.manifest.target)}`
        })
        .join('\n')
    },

    async start(
      sessionId: SessionId,
      workingDir: string,
      workflow: string,
      inputs: Readonly<Record<string, string>>,
      kickoff: RunKickoff = {}
    ): Promise<string> {
      // A workspace folder that is no repository may still start runs in the
      // repositories inside it; only a run in its own repository is refused.
      const repository = await checkoutRootOf(workingDir).catch(() => undefined)
      const root = repository ?? workingDir
      const named = given(kickoff.base)
      const target = given(kickoff.target)
      const request: StartRunRequest = {
        workspacePath: root,
        workspaceName: basename(root),
        sessionId,
        workflow,
        inputs,
        ...(target === undefined ? {} : { target }),
        base: async (settled) => {
          if (settled.named !== undefined) return named ?? (await headOf(settled.path))
          if (repository === undefined) {
            throw new Error(
              `${workingDir} is not inside a git repository, so a run has no commit to branch ` +
                'from. Name a `target` to run in a git repository inside it.'
            )
          }
          // The session's own HEAD — the worktree's when it works in one —
          // unless the agent named another commit.
          return named ?? (await headOf(workingDir))
        }
      }
      const run = await engine.start(request)
      return (
        `Run ${run.id} of "${run.workflow}" started · ` +
        (run.targetRepository === undefined ? '' : `repository ${run.targetRepository} · `) +
        `branch ${run.branch} · ` +
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
    },

    // No session check, as `answer` has none: the deliberate call is the spend
    // authorization, and the run keeps reporting to the orchestrator its
    // record names.
    async resume(_sessionId: SessionId, runId: string, kind?: ResumeKind): Promise<string> {
      // Read before the act: once the run is working, where it stopped is no
      // longer on the record to name.
      const before = engine.runs().find((candidate) => candidate.id === runId)
      // Copied, not held: the engine mutates its node records in place, and
      // this is read after they have gone back to work.
      const stopped =
        before === undefined
          ? undefined
          : { ...before, nodes: before.nodes.map((node) => ({ ...node })) }
      await engine.resume(runId, kind)
      const run = engine.runs().find((candidate) => candidate.id === runId)
      if (run === undefined) throw new Error(`No run is named "${runId}".`)
      return resumeAnswer(run, stopped, kind)
    }
  }

  // One hook, consulted once per user turn: it wakes whatever interruption
  // notices this session is owed and answers with the invisible status block.
  // Every rule about runs stays in the engine; the wording is this module's.
  const turnStart = createTurnStart({
    runs: () => engine.runs(),
    deliverNotices: (sessionId) => engine.deliverNotices(sessionId)
  })

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

    async resume(runId: string, kind?: ResumeKind): Promise<void> {
      await engine.resume(runId, kind)
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
      return await engine.nodeTranscript(runId, nodeId)
    },

    async artifact(runId: string, path: string): Promise<ArtifactView> {
      gate(runId, path)
      const kind = artifactKind(path)
      let bytes: number
      let modifiedAt: string | undefined
      try {
        // Off the loop, both calls: an agent chose this file and nothing caps
        // its size, so a 100 MB artifact would otherwise hold the window for
        // the whole read.
        const stamp = await stat(path)
        bytes = stamp.size
        modifiedAt = stamp.mtime.toISOString()
      } catch {
        throw new Error(`That artifact could not be read: ${basename(path)}.`)
      }
      if (kind === 'html') {
        return { kind, bytes, ...(modifiedAt === undefined ? {} : { modifiedAt }) }
      }
      try {
        return {
          kind,
          body: await readFile(path, 'utf8'),
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

    turnStart,

    // The whole of what a scheduled fire is beyond an ordinary run: the trunk
    // of its target repository for a base, nothing handed in, nobody to
    // report to, and the marker that puts it on the schedule board.
    async startScheduled(fire: ScheduledFireRequest) {
      return engine.start({
        workspacePath: fire.workspacePath,
        workspaceName: basename(fire.workspacePath),
        workflow: fire.workflow,
        inputs: {},
        base: (target) => base(target.path),
        scheduled: true
      })
    },

    toggleOverview(): void {
      for (const listener of [...listeners]) listener({ type: 'toggle-overview' })
    },

    dispose(): void {
      if (broadcastTimer !== undefined) clearTimeout(broadcastTimer)
      listeners.clear()
      engine.dispose()
    }
  }
}

/** A tool argument with something in it, trimmed; blank is the same as absent. */
function given(argument: string | undefined): string | undefined {
  const trimmed = argument?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/** What an orchestrator has to know about a workflow's target before it starts one. */
function targetLine(target: TargetDeclaration | undefined): string {
  if (target === undefined) return ''
  if (typeof target === 'object') {
    return (
      '\n  target: required — name a repository inside the workspace with ' +
      "crucible_run's `target`"
    )
  }
  return `\n  target: ${target} — fixed; name it or no target at all`
}
