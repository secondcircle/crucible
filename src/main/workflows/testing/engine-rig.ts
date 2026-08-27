// The rig the engine's tests run on: a real temporary git repository, the
// shipped engine, and node sessions that are scripts rather than agents (the
// seam is the point — no SDK anywhere). Everything a test asserts on is
// observable from outside: run records, orchestrator messages, the filesystem.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ObservedCacheMiss } from '../../../shared/agent/adapter'
import type { SessionId, TranscriptItem } from '../../../shared/agent/port'
import type { CacheRecorder, RecordedCacheMiss } from '../../cache/ledger'
import type { WorkflowDef } from '../authoring'
import { createWorkflowEngine, type WorkflowEngine } from '../engine'
import type {
  NodeBlocker,
  NodeCompletion,
  NodeSession,
  NodeSessionFactory,
  NodeSessionRequest
} from '../node-session'
import type { LoadedWorkflow, WorkflowLoader } from '../loader'
import { createRunStore } from '../store'

const scratch: string[] = []

/** Every temporary directory this rig made, gone. Call it from `afterEach`. */
export function cleanupScratch(): void {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** A real repository with one commit, which is all a run needs to branch. */
export function tempRepo(): string {
  const repo = tempDir('crucible-engine-repo-')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.invalid')
  git(repo, 'config', 'user.name', 'Crucible Test')
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'first')
  return repo
}

/** What a scripted node may do on one prompt. */
export interface NodeTools {
  readonly complete: (completion: NodeCompletion) => void
  readonly block: (blocker: NodeBlocker) => void
  /** A cache miss on this node's turn, as the SDK factory reports one. */
  readonly cacheMiss: (miss: ObservedCacheMiss) => void
  /** A line of liveness, which is what the engine snapshots the node on. */
  readonly activity: (doing: string) => void
  readonly cwd: string
  // The first prompt of the session, which is the one naming the output
  // paths; later prompts (rejections, blocker answers, shoves) do not.
  readonly taskPrompt: string
}

// A script that returns a promise is a turn still under way, which is how a
// node's record is read while its agent is working.
export type NodeScript = (prompt: string, tools: NodeTools, turn: number) => void | Promise<void>

/** The prompt names every output path; a script writes one by its file name. */
export function outputPath(prompt: string, file: string): string {
  const line = prompt.split('\n').find((candidate) => candidate.includes(file))
  const match = line === undefined ? null : /- (\S+) —/.exec(line)
  if (match === null) throw new Error(`no output path for ${file} in the prompt`)
  return match[1]
}

export function scriptedSessions(
  scriptFor: (nodeId: string) => NodeScript
): NodeSessionFactory & {
  readonly prompts: string[]
  readonly requests: NodeSessionRequest[]
} {
  const prompts: string[] = []
  const requests: NodeSessionRequest[] = []
  return {
    prompts,
    requests,
    async start(request: NodeSessionRequest): Promise<NodeSession> {
      requests.push(request)
      const nodeId = /^You are "([^"]+)"/.exec(request.rolePrompt)?.[1] ?? 'unknown'
      const script = scriptFor(nodeId)
      let turn = 0
      let disposed = false
      let taskPrompt = ''
      const activityListeners = new Set<(now: string | undefined) => void>()
      return {
        async prompt(text: string): Promise<void> {
          if (disposed) return
          prompts.push(`${nodeId}: ${text.split('\n')[0]}`)
          turn += 1
          if (turn === 1) taskPrompt = text
          await script(
            text,
            {
              complete: (completion) => request.onComplete(completion),
              block: (blocker) => request.onBlocker(blocker),
              cacheMiss: (miss) => request.onCacheMiss?.(miss),
              activity: (doing) => {
                for (const listener of [...activityListeners]) listener(doing)
              },
              cwd: request.cwd,
              taskPrompt
            },
            turn
          )
        },
        async abort(): Promise<void> {},
        isStreaming: () => false,
        stats: () => ({ toolCalls: turn * 3, cost: turn * 0.25, contextPercent: 10 * turn }),
        transcript: (): readonly TranscriptItem[] => [
          { kind: 'assistant', markdown: `scripted node ${nodeId}, turn ${turn}` }
        ],
        onActivity: (listener) => {
          activityListeners.add(listener)
          return () => activityListeners.delete(listener)
        },
        dispose: () => {
          disposed = true
        }
      }
    }
  }
}

export function loaderOf(defs: Record<string, WorkflowDef>): WorkflowLoader {
  function loaded(name: string): LoadedWorkflow {
    const def = defs[name]
    if (def === undefined) throw new Error(`No workflow is named "${name}".`)
    return { name, origin: 'workspace', path: `/workspace/.crucible/workflows/${name}.ts`, def }
  }
  return {
    async list() {
      return Object.keys(defs).map(loaded)
    },
    async resolve(_workspace: string, name: string) {
      return loaded(name)
    }
  }
}

export interface Rig {
  readonly engine: WorkflowEngine
  readonly repo: string
  readonly stateDir: string
  readonly delivered: { sessionId: SessionId; text: string }[]
  readonly sessions: ReturnType<typeof scriptedSessions>
  /** Every ledger line the run wrote, in order. */
  readonly recorded: RecordedCacheMiss[]
  // Makes delivery fail the way a launch with no shell up fails: the run's
  // messages throw instead of landing, which is what leaves a notice owed.
  refuseDelivery(on: boolean): void
}

export interface RigOptions {
  // A repository and a state directory an earlier rig already made: what a
  // relaunch of the same app over the same records looks like.
  readonly repo?: string
  readonly stateDir?: string
  /** Whether a recorded orchestrator session still exists, as resume asks. */
  readonly sessionExists?: (sessionId: SessionId) => boolean
}

export function rig(
  defs: Record<string, WorkflowDef>,
  scriptFor: (nodeId: string) => NodeScript,
  options: RigOptions = {}
): Rig {
  const repo = options.repo ?? tempRepo()
  const stateDir = options.stateDir ?? tempDir('crucible-engine-state-')
  const delivered: { sessionId: SessionId; text: string }[] = []
  const recorded: RecordedCacheMiss[] = []
  const sessions = scriptedSessions(scriptFor)
  let refusing = false
  // A stand-in for the ledger: what a run writes is checkable without a file.
  const cache: CacheRecorder = {
    retention: '5m',
    ledgerPath: join(stateDir, 'cache-misses.jsonl'),
    append: async (miss) => {
      recorded.push(miss)
    }
  }
  const engine = createWorkflowEngine({
    loader: loaderOf(defs),
    store: createRunStore(stateDir),
    sessions,
    deliver: (sessionId, text) => {
      if (refusing) throw new Error('no shell is up to carry a run message yet')
      delivered.push({ sessionId, text })
    },
    ...(options.sessionExists === undefined ? {} : { sessionExists: options.sessionExists }),
    cache,
    onChanged: () => {},
    pollMs: 5,
    watchdogMs: 60_000,
    quietAbortMs: 600_000,
    releaseWaitMs: 100
  })
  return {
    engine,
    repo,
    stateDir,
    delivered,
    sessions,
    recorded,
    refuseDelivery(on: boolean): void {
      refusing = on
    }
  }
}

// The same app started again over the same records and the same repository:
// its engine sweeps what the last one left mid-flight, and its node sessions
// are a fresh script.
export function relaunch(
  before: Rig,
  defs: Record<string, WorkflowDef>,
  scriptFor: (nodeId: string) => NodeScript,
  options: Omit<RigOptions, 'repo' | 'stateDir'> = {}
): Rig {
  return rig(defs, scriptFor, { ...options, repo: before.repo, stateDir: before.stateDir })
}

export async function until(what: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms
  while (!what()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export function startRequest(repo: string, workflow: string, inputs: Record<string, string>) {
  return {
    workspacePath: repo,
    workspaceName: 'engine-test',
    sessionId: 'orchestrator-1',
    workflow,
    inputs,
    base: 'HEAD'
  }
}
