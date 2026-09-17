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
import type { RunRecord } from '../../../shared/workflows/run'
import type { CacheRecorder, RecordedCacheMiss } from '../../cache/ledger'
import type { WorkflowDef } from '../authoring'
import { createWorkflowEngine, type EngineOptions, type WorkflowEngine } from '../engine'
import type {
  NodeBlocker,
  NodeCompletion,
  NodeSession,
  NodeSessionFactory,
  NodeSessionRequest
} from '../node-session'
import { inProcessHost } from '../host/host'
import type { LoadedWorkflow, WorkflowLoader } from '../loader'
import { createRunStore, type RunStore } from '../store'

const scratch: string[] = []

// Every temporary directory this rig made, gone. Call it from `afterEach`.
// Retried, because a test may return before the run it started has wound
// all the way down: an engine disposed mid-node still commits the worktree,
// and a git process writing into a directory being removed is an ENOTEMPTY
// that says nothing about the test.
export function cleanupScratch(): void {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
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

// The sessions a rig has handed out, so a relaunch can reopen one exactly as
// the SDK factory reopens a session file: what it had said, and its task. A
// token no rig ever minted will not open, which is what an unreadable
// session looks like.
const scriptedSessionFiles = new Map<string, { turns: number; taskPrompt: string }>()

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
  /** Set when this session was reopened rather than started fresh. */
  readonly continued: boolean
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
  scriptFor: (nodeId: string) => NodeScript,
  options: { readonly keepSessions?: boolean } = {}
): NodeSessionFactory & {
  readonly prompts: string[]
  readonly models: string[]
  readonly requests: NodeSessionRequest[]
} {
  const prompts: string[] = []
  const models: string[] = []
  const requests: NodeSessionRequest[] = []
  // Sessions are kept unless a test says otherwise, because the real factory
  // keeps them: a factory that keeps none is what a record written before
  // they were kept looks like.
  const keeping = options.keepSessions !== false
  return {
    prompts,
    models,
    requests,
    async start(request: NodeSessionRequest): Promise<NodeSession> {
      requests.push(request)
      const nodeId = /^You are "([^"]+)"/.exec(request.rolePrompt)?.[1] ?? 'unknown'
      models.push(`${nodeId}: ${request.model}`)
      const script = scriptFor(nodeId)
      let turn = 0
      let disposed = false
      let taskPrompt = ''
      const activityListeners = new Set<(now: string | undefined) => void>()

      // A reopened session carries its earlier turns, exactly as π's does:
      // the stats it reports count them, and the engine must not bill them
      // to the record a second time.
      const continued = request.resumeToken !== undefined
      let token: string | undefined
      if (continued) {
        const before = scriptedSessionFiles.get(request.resumeToken ?? '')
        if (before === undefined) throw new Error('no such session file')
        turn = before.turns
        // The task is still in the conversation this session reopened.
        taskPrompt = before.taskPrompt
        token = request.resumeToken
      } else if (keeping) {
        token = join(request.sessionDir, `${scriptedSessionFiles.size + 1}.jsonl`)
      }
      const remember = (): void => {
        if (token !== undefined) scriptedSessionFiles.set(token, { turns: turn, taskPrompt })
      }
      remember()

      return {
        token: () => token,
        async prompt(text: string): Promise<void> {
          if (disposed) return
          prompts.push(`${nodeId}: ${text.split('\n')[0]}`)
          turn += 1
          if (taskPrompt === '') taskPrompt = text
          remember()
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
              taskPrompt,
              continued
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

// Definitions built in the test, served through in-process hosts: the engine
// is exercised against the host interface exactly as in a launch, minus the
// process, which the host's own tests cover.
export function loaderOf(defs: Record<string, WorkflowDef>): WorkflowLoader {
  async function loaded(name: string): Promise<LoadedWorkflow> {
    const def = defs[name]
    if (def === undefined) throw new Error(`No workflow is named "${name}".`)
    return {
      name,
      origin: 'workspace',
      path: `/workspace/.crucible/workflows/${name}.ts`,
      manifest: await inProcessHost(def).manifest(),
      open: () => inProcessHost(def)
    }
  }
  return {
    async list() {
      return Promise.all(Object.keys(defs).map(loaded))
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
  /** The store the engine writes through, for tests about what is on disk. */
  readonly store: RunStore
  readonly delivered: { sessionId: SessionId; text: string }[]
  readonly sessions: ReturnType<typeof scriptedSessions>
  /** Every ledger line the run wrote, in order. */
  readonly recorded: RecordedCacheMiss[]
  // Makes delivery fail the way a launch with no shell up fails: the run's
  // messages throw instead of landing, which is what leaves a notice owed.
  refuseDelivery(on: boolean): void
}

// Everything the engine takes, so a test drives whichever seam it is about,
// plus the two directories a relaunch has to reuse.
export interface RigOptions extends Partial<EngineOptions> {
  // A repository and a state directory an earlier rig already made: what a
  // relaunch of the same app over the same records looks like.
  readonly repo?: string
  readonly stateDir?: string
  // False for a launch whose node sessions leave nothing behind, which is
  // what a record written before sessions were kept resumes against.
  readonly keepSessions?: boolean
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
  const store = rigStore(stateDir)
  const sessions = scriptedSessions(scriptFor, {
    ...(options.keepSessions === undefined ? {} : { keepSessions: options.keepSessions })
  })
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
    store,
    sessions,
    deliver: (sessionId, text) => {
      if (refusing) throw new Error('no shell is up to carry a run message yet')
      delivered.push({ sessionId, text })
    },
    cache,
    onChanged: () => {},
    pollMs: 5,
    watchdogMs: 60_000,
    quietAbortMs: 600_000,
    releaseWaitMs: 100,
    // Last, so a test that names a seam wins over the defaults above.
    ...engineOverrides(options)
  })
  return {
    engine,
    repo,
    stateDir,
    store,
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
  // What the quit does before the process goes: the store writes whatever it
  // was holding. Without it a relaunch would read a record a write behind,
  // which is a different test — the one about tolerating staleness.
  before.store.flush()
  return rig(defs, scriptFor, { ...options, repo: before.repo, stateDir: before.stateDir })
}

/** The run store a rig's engine writes through, with its own write interval. */
export function rigStore(stateDir: string): RunStore {
  // Tests assert on what is on disk, so writes are not held back: the
  // interval is the store's own subject, tested where the store is.
  return createRunStore(stateDir, undefined, 0)
}

// What the next launch would read. The store writes off the caller's thread,
// so a test reading the disk asks for what it is still holding first — which
// is what the quit does anyway.
export function recordsOnDisk(rig: Pick<Rig, 'store' | 'stateDir'>): readonly RunRecord[] {
  rig.store.flush()
  return createRunStore(rig.stateDir).load()
}

// The rig's own two keys stripped out, so what is left is engine options and
// nothing else.
function engineOverrides(options: RigOptions): Partial<EngineOptions> {
  const rest: Record<string, unknown> = { ...options }
  delete rest.repo
  delete rest.stateDir
  delete rest.keepSessions
  return rest as Partial<EngineOptions>
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
