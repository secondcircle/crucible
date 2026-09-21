import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { SessionId, TranscriptItem } from '../../shared/agent/port'
import {
  CONTINUED_NODE_MESSAGE,
  dismissRefusal,
  INTERRUPTED_MESSAGE,
  latestNodeActivity,
  nextRevisionId,
  nodeChain,
  RELEASED_ON_RUN_END,
  resumeRefusal,
  runCanResume,
  runMessageHeader,
  type ResumeKind,
  type RunArtifact,
  type RunEffect,
  type RunNodeStatus,
  type RunRecord,
  type RunStatus,
  type WorkflowRunId
} from '../../shared/workflows/run'
import { interruptionNotice } from '../../shared/workflows/status'
import type { MonitorOwner } from '../../shared/monitors/monitor'
import type { NodeMonitors } from '../../shared/monitors/service'
import { lostMonitorsNotice } from '../../shared/monitors/wording'
import type { NodeResult, NodeSpec, OpenNode, PlannedNode, ReviseOptions } from './authoring'
import type { EngineContext, RecordedEffect } from './host/protocol'
import type { CacheRecorder } from '../cache/ledger'
import { narrowSkills, type SkillService } from '../skills/service'
import type { WorkflowHost, WorkflowManifest } from './host/host'
import type { WorkflowLoader } from './loader'
import type { NodeSession, NodeSessionFactory } from './node-session'
import type { RunStore } from './store'
import { checkVerdict } from './verdict'
import { commitRunWorktree, createRunWorktree, type RunWorktree } from './worktree'

// The engine: executes runs, one seam away from agents and one away from the
// workflow's own code. Ported from the legacy runner with the venue machinery
// deleted — every run works in a worktree of its own, branched from a commit
// named at kickoff — and the dashboard's answer channel replaced by the
// orchestrator: every check-in, blocker, stall and completion is delivered as
// a message to the run's session agent, and answers come back through
// crucible_answer. The workflow file itself runs in a workflow host, a
// process of its own; what the engine holds is the host, and the run context
// it answers the file's calls with.

const DEFAULT_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']

const NUDGE_LIMIT = 2
const VALIDATION_RETRY_LIMIT = 3

// What a node run again from its prompt hears, when its own session could
// not be reopened. A clean restart asked for by name says the same thing:
// the transcript that stopped stays readable, and this agent has none of it.
const RESTART_NOTICE =
  'You are picking this node up in a fresh session: the earlier attempt stopped and its ' +
  'conversation is not available, while the worktree and the artifacts hold the work that was ' +
  'already done. Read what is there before you change it.'

/**
 * A recorded session that would not reopen — no factory that keeps them, a
 * record written before they were kept, a file since deleted. Thrown where
 * the session opens and caught where the node starts, which is the one place
 * that can still choose to run the node again instead.
 */
class SessionGone extends Error {}

export interface StartRunRequest {
  readonly workspacePath: string
  readonly workspaceName: string
  // The orchestrator session. Absent is an unattended run: it speaks to
  // nobody and parks on anything it cannot resolve, until a session adopts it.
  readonly sessionId?: SessionId
  /** Fired from the schedule surface: a clock fire, or the board's Run now. */
  readonly scheduled?: boolean
  /** The workflow's name, resolved through the origin ladder. */
  readonly workflow: string
  readonly inputs: Readonly<Record<string, string>>
  /** Commit-ish the run branches from. */
  readonly base: string
}

export interface WorkflowEngine {
  /** Every record the engine knows, live and finished, newest first. */
  runs(): readonly RunRecord[]
  /** Resolves at kickoff; the run continues in the background. */
  start(request: StartRunRequest): Promise<RunRecord>
  pause(runId: WorkflowRunId): void
  // Total over every stop short of completion, paused included. The stopped
  // node continues from its last turn in its own session, in the same
  // worktree; everything the run already did — completed nodes, answered
  // check-ins, recorded effects — is handed back from the record at no cost.
  // `clean-restart` is the other act: the stopped node runs again from its
  // prompt, as a revision, with no memory of the attempt that stopped.
  // Resolves once the run is working again; the run continues in background.
  resume(runId: WorkflowRunId, kind?: ResumeKind): Promise<void>
  cancel(runId: WorkflowRunId): void
  // Every run of this session that is owed an interruption notice says it now,
  // through the ordinary delivery path. Called by the run service's turn-start
  // hook when a user turn begins. Not "wake": that word belongs to a monitor's
  // message now, and a method of that name delivering interruption notices
  // would mislead every reader.
  deliverNotices(sessionId: SessionId): void
  /** Stamps a settled run dismissed; refuses a live one. Stamping twice is a no-op. */
  dismiss(runId: WorkflowRunId): void
  /** Hands the run to another session: every later message goes there. */
  adopt(runId: WorkflowRunId, sessionId: SessionId): void
  /** The orchestrator's answer to whatever the run is waiting on. */
  answer(runId: WorkflowRunId, message: string): void
  nodeTranscript(runId: WorkflowRunId, nodeId: string): Promise<readonly TranscriptItem[]>
  /** Abandons live work; records keep whatever state they reached. */
  dispose(): void
}

export interface EngineOptions {
  readonly loader: WorkflowLoader
  readonly store: RunStore
  readonly sessions: NodeSessionFactory
  /** How a run speaks: a message to its orchestrator session's agent. */
  readonly deliver: (sessionId: SessionId, text: string) => void
  // Whether a recorded orchestrator session still exists, asked when a run
  // resumes: a run whose session is gone goes unattended rather than talking
  // to nobody. Absent presumes every recorded session exists.
  readonly sessionExists?: (sessionId: SessionId) => boolean
  // Where a node's cache misses are written down. Absent records nothing; the
  // run's own count lands on the record either way, because that is what the
  // chip's mark is drawn from.
  readonly cache?: CacheRecorder
  // Read against the run's own worktree, so a skill the run's branch adds is
  // offered to the nodes that follow. Absent means no node is offered any.
  readonly skills?: SkillService
  // Every node's monitor tools and its wait. Absent — tests that are not
  // about waiting — means nodes get no monitor tools and never wait;
  // production always passes it.
  readonly monitors?: NodeMonitors
  /** Fired after any record change; the service fans it out. */
  readonly onChanged: () => void
  readonly log?: (event: Record<string, unknown>) => void
  /** "provider/model-id:thinkingLevel" for nodes that name none. */
  readonly defaultModel?: string
  /**
   * The last word on which model a node runs, asked once when the run is
   * planned and again as each node starts — usage moves while a run works, and
   * a forecast made an hour ago should not decide what gets spent now.
   */
  readonly chooseModel?: (model: string) => Promise<string> | string
  /** Test knobs; production leaves them alone. */
  readonly pollMs?: number
  readonly watchdogMs?: number
  readonly quietAbortMs?: number
  readonly releaseWaitMs?: number
}

/* The shared record with its readonly loosened: the engine mutates in place
 * and saves the same object, which is safe because everything leaving the
 * engine crosses IPC or a JSON write. */
interface LiveNode {
  id: string
  status: RunNodeStatus
  parents: string[]
  model?: string
  reads: RunArtifact[]
  artifacts: RunArtifact[]
  verdict?: unknown
  summary?: string
  error?: string
  startedAt?: string
  endedAt?: string
  lastActivityAt?: string
  now?: string
  toolCalls?: number
  contextPercent?: number
  cost?: number
  cacheMisses?: number
  waitingOn?: { monitorId: string; description: string; since: string }
  sessionToken?: string
}

interface LiveRun {
  id: WorkflowRunId
  workflow: string
  status: RunStatus
  workspacePath: string
  workspaceName: string
  sessionId?: SessionId
  scheduled?: true
  worktreePath?: string
  branch?: string
  baseCommit?: string
  finalCommit?: string
  inputs: Record<string, string>
  inputDescs?: Record<string, string>
  question?: {
    reason: string
    nodeId?: string
    raisedAt: string
    answeredAt?: string
    answer?: string
  }
  waiting?: boolean
  nodes: LiveNode[]
  effects?: RunEffect[]
  outputs?: Record<string, unknown>
  error?: string
  after?: string
  createdAt: string
  startedAt?: string
  endedAt?: string
  dismissedAt?: string
  dir?: string
  noticePending?: true
}

interface Waiter {
  resolve(answer: string): void
  reject(cause: Error): void
}

interface StagedSuccessor {
  readonly workflow: string
  readonly inputs: Record<string, string>
}

type ReleaseReason = 'run-ended' | 'quitting'

interface Handle {
  readonly run: LiveRun
  /** The process the workflow's own code runs in; killed when the run stops. */
  readonly host: WorkflowHost
  desired: 'running' | 'paused' | 'cancelled'
  cancelRequested: boolean
  readonly pauseInterrupts: Set<() => void>
  readonly waiters: Waiter[]
  readonly live: Set<{
    release(why: ReleaseReason): Promise<void>
    forceDispose(why: ReleaseReason): void
  }>
  readonly pending: Set<Promise<unknown>>
  readonly staged: StagedSuccessor[]
}

export function createWorkflowEngine(options: EngineOptions): WorkflowEngine {
  const {
    loader,
    store,
    sessions,
    deliver,
    sessionExists,
    cache,
    skills,
    monitors,
    onChanged,
    log,
    defaultModel = 'anthropic/claude-opus-5:high',
    chooseModel = (model: string) => model,
    pollMs = 1000,
    watchdogMs = 15_000,
    quietAbortMs = 5 * 60_000,
    releaseWaitMs = 30_000
  } = options

  // Everything ever recorded, newest first; live handles by id beside it.
  const records: LiveRun[] = [...(store.load() as unknown as LiveRun[])]
  const handles = new Map<WorkflowRunId, Handle>()
  let disposed = false

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  const nowIso = (): string => new Date().toISOString()

  // The sessions a running record's nodes were holding died with the process,
  // so the record is a lie the moment it is read back. Settle it as
  // interrupted — the app went away, the work did not go wrong — and only a
  // deliberate Resume moves it from here.
  for (const stale of records) {
    if (stale.status !== 'running' && stale.status !== 'paused') continue
    stale.status = 'interrupted'
    stale.error =
      stale.error === undefined
        ? INTERRUPTED_MESSAGE
        : `${stale.error}; ${INTERRUPTED_MESSAGE}`
    // The app may have been closed for a week, so sweep time would be a fresh
    // lie: the honest stop is the last thing any node was seen doing.
    stale.endedAt = latestNodeStop(stale) ?? stale.endedAt ?? nowIso()
    // The waiter died with the process; nothing can answer it now.
    stale.waiting = false
    delete stale.question
    for (const node of stale.nodes) {
      if (
        node.status !== 'running' &&
        node.status !== 'paused' &&
        node.status !== 'blocked' &&
        node.status !== 'stalled'
      ) {
        continue
      }
      node.status = 'interrupted'
      node.error ??= INTERRUPTED_MESSAGE
      node.endedAt ??= node.lastActivityAt ?? nowIso()
      delete node.now
      delete node.waitingOn
    }
    // No shell exists this early, so delivery is not even attempted: the
    // record carries the debt until the session next wakes.
    if (stale.sessionId !== undefined) stale.noticePending = true
    store.save(stale as RunRecord)
  }

  function save(run: LiveRun): void {
    store.save(run as RunRecord)
    onChanged()
  }

  // A chooser that throws must never cost a node its turn, so the declared
  // model stands and the trouble goes to the log instead.
  async function modelFor(declared: string, where: Record<string, unknown>): Promise<string> {
    let chosen: string
    try {
      chosen = await chooseModel(declared)
    } catch (cause) {
      log?.({
        event: 'model_choice_failed',
        ...where,
        model: declared,
        message: cause instanceof Error ? cause.message : String(cause)
      })
      return declared
    }
    if (chosen !== declared) log?.({ event: 'model_swapped', ...where, from: declared, to: chosen })
    return chosen
  }

  function requireRecord(runId: WorkflowRunId): LiveRun {
    const found = records.find((candidate) => candidate.id === runId)
    if (found === undefined) throw new Error(`No run is named "${runId}".`)
    return found
  }

  function mintId(): WorkflowRunId {
    for (;;) {
      const id = randomBytes(2).toString('hex')
      if (!records.some((candidate) => candidate.id === id)) return id
    }
  }

  /** A run speaks only to its orchestrator; a run with none is only observed. */
  function tell(run: LiveRun, text: string): void {
    if (run.sessionId === undefined) return
    try {
      deliver(run.sessionId, text)
    } catch (cause) {
      log?.({
        event: 'run_delivery_failed',
        runId: run.id,
        message: cause instanceof Error ? cause.message : String(cause)
      })
      return
    }
    // Any message that reaches the orchestrator is the wake-up an interruption
    // notice was owed, so a blocker or a completion settles the debt as surely
    // as the notice itself. Cleared here and written, in the one module that
    // both sets the flag and says everything a run says.
    if (run.noticePending === true) {
      delete run.noticePending
      save(run)
    }
  }

  /** Park until crucible_answer arrives. The rejection is the release path. */
  function awaitAnswer(handle: Handle): Promise<string> {
    // A node that goes quiet after cancel has already swept the waiters would
    // otherwise register a fresh one nobody is left to reject, and wait out
    // the process. Cancel is a decision about the whole run, so it holds for
    // waiters raised after it as well as the ones it found.
    if (handle.cancelRequested) return Promise.reject(new Error('the run was cancelled'))
    handle.run.waiting = true
    return new Promise<string>((resolve, reject) => {
      handle.waiters.push({
        resolve(answer: string) {
          resolve(answer)
        },
        reject
      })
    })
  }

  function rejectWaiters(handle: Handle, why: string): void {
    const waiting = handle.waiters.splice(0, handle.waiters.length)
    handle.run.waiting = false
    for (const waiter of waiting) waiter.reject(new Error(why))
  }

  async function start(request: StartRunRequest): Promise<RunRecord> {
    return startInternal(request, {})
  }

  async function startInternal(
    request: StartRunRequest,
    chain: { readonly branch?: string; readonly after?: WorkflowRunId }
  ): Promise<RunRecord> {
    const resolved = await loader.resolve(request.workspacePath, request.workflow)
    const { manifest } = resolved

    // Every declared input is a path to an existing file, checked before
    // anything costs money; names the workflow never declared are refused so
    // a typo cannot silently drop an input.
    const inputs: Record<string, string> = { ...request.inputs }
    for (const name of Object.keys(inputs)) {
      if (!(name in manifest.inputs)) {
        throw new Error(`The workflow "${resolved.name}" takes no input named "${name}".`)
      }
    }
    for (const [name, description] of Object.entries(manifest.inputs)) {
      const path = inputs[name]
      if (path === undefined) {
        throw new Error(`The workflow "${resolved.name}" needs "${name}": ${description}`)
      }
      if (!existsSync(path)) {
        throw new Error(`The input "${name}" names a file that does not exist: ${path}`)
      }
    }

    // The process the workflow's code runs in, for the plan and then the run.
    // Anything that fails between here and the run starting kills it: a host
    // with no run to serve is a leaked process.
    const host = resolved.open()
    let planned: readonly PlannedNode[]
    let id: WorkflowRunId
    let worktree: RunWorktree
    let plannedModels: readonly string[]
    try {
      // Planning doubles as validation: a throw here fails the kickoff.
      planned = manifest.plans ? await host.plan(inputs) : []

      id = mintId()
      worktree = await createRunWorktree({
        workspacePath: request.workspacePath,
        runId: id,
        base: request.base,
        ...(chain.branch === undefined ? {} : { branch: chain.branch })
      })

      // The rail's forecast names what the run would spend on now; every node
      // asks again for itself when it starts.
      plannedModels = await Promise.all(
        planned.map((plan) => modelFor(plan.model ?? defaultModel, { runId: id, nodeId: plan.id }))
      )
    } catch (cause) {
      host.kill()
      throw cause
    }
    const artifactDir = store.artifactDir(id)

    const run: LiveRun = {
      id,
      workflow: resolved.name,
      status: 'running',
      workspacePath: request.workspacePath,
      workspaceName: request.workspaceName,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(request.scheduled === true ? { scheduled: true as const } : {}),
      worktreePath: worktree.path,
      branch: worktree.branch,
      baseCommit: worktree.baseCommit,
      inputs,
      inputDescs: { ...manifest.inputs },
      dir: store.runDir(id),
      nodes: planned.map(
        (plan, at): LiveNode => ({
          id: plan.id,
          status: 'pending',
          parents: plan.parents ?? [],
          model: plannedModels[at],
          reads: [],
          // A ghost carries what the plan says it will write, so the rail has
          // the whole shape of the run from the first minute.
          artifacts: Object.entries(plan.outputs ?? {}).map(([name, output]) => ({
            name,
            path: join(artifactDir, output.file),
            desc: output.desc
          }))
        })
      ),
      ...(chain.after === undefined ? {} : { after: chain.after }),
      createdAt: nowIso(),
      startedAt: nowIso()
    }
    records.unshift(run)

    const handle: Handle = {
      run,
      host,
      desired: 'running',
      cancelRequested: false,
      pauseInterrupts: new Set(),
      waiters: [],
      live: new Set(),
      pending: new Set(),
      staged: []
    }
    handles.set(id, handle)
    save(run)
    log?.({ event: 'run_started', runId: id, workflow: resolved.name, branch: worktree.branch })

    // The run continues on its own; kickoff is over. A crash in the executor
    // is recorded on the run, never thrown at nobody.
    void execute(handle, manifest).catch((cause: unknown) => {
      host.kill()
      run.status = 'failed'
      run.error = cause instanceof Error ? cause.message : String(cause)
      run.endedAt = nowIso()
      save(run)
      log?.({ event: 'run_crashed', runId: id, message: run.error })
    })

    return run as RunRecord
  }

  // What a resumed run brings: the record already holds what a previous life
  // did, and `run()` executes again over it. Nodes it completed are handed
  // back, effects and check-in answers it recorded are handed back, and the
  // node it stopped on carries on in its own session — unless this is a clean
  // restart, which runs that node again from its prompt as a revision. A
  // first run replays nothing, so nothing about it changes.
  async function execute(
    handle: Handle,
    manifest: WorkflowManifest,
    resumed?: ResumeKind
  ): Promise<void> {
    const { run, host } = handle
    const replay = resumed !== undefined
    const artifacts = store.artifactDir(run.id)
    const cwd = run.worktreePath ?? run.workspacePath

    const pauseAsked = (): boolean => handle.desired === 'paused'
    const cancelAsked = (): boolean => handle.cancelRequested

    /** Artifact path → id of the node that declared it as an output. */
    const producerByArtifact = new Map<string, string>()

    const track = (promise: Promise<NodeResult>): Promise<NodeResult> => {
      handle.pending.add(promise)
      const drop = (): void => {
        handle.pending.delete(promise)
      }
      promise.then(drop, drop)
      return promise
    }

    // Every id this execution has already put a record behind, so a workflow
    // asking for one node twice is still refused. On a resumed run the ids the
    // previous life recorded are not taken: replaying or re-running them is
    // the whole point of resuming.
    const taken = new Set<string>()

    // What a previous life recorded under a key of its own, to be handed back
    // instead of done again, and the keys this execution has written. A first
    // run replays nothing and records everything.
    const recordedEffects = new Map<string, RunEffect>(
      (replay ? (run.effects ?? []) : []).map((effect) => [effect.key, effect])
    )
    // Every effect id this execution has claimed, whether its value came off
    // the record or out of the work, and the subset it has written. One id,
    // once per run: an id that replays is still claimed, so a workflow asking
    // for one twice fails on a resumed run exactly as it does on a first one.
    const effectsClaimed = new Set<string>()
    const effectsRecorded = new Set<string>()
    // Check-ins carry no id of their own, so the key is their order in the
    // run: `run()` re-executes from the top, and the nth check-in of a
    // resumed run is the nth check-in of the life before it. The · is the
    // engine's own marker in ids, so no workflow's effect id collides.
    // Notifications are keyed the same way, in a count of their own.
    let asks = 0
    let notifies = 0

    // Every record one node's session has taken: `id`, then `id·rN` in
    // order. One session, several records, which is what a revision is. The
    // rule lives in shared/workflows/run.ts, where the surfaces read it, so
    // what a run view or an orchestrator is told about a node is worked out
    // from the same records this is about to act on.
    function chainOf(id: string): readonly LiveNode[] {
      return nodeChain(run.nodes, id)
    }

    /** The furthest completed record of that chain: a replayed handle's result. */
    function furthestComplete(id: string): LiveNode | undefined {
      return chainOf(id)
        .filter((candidate) => candidate.status === 'complete')
        .at(-1)
    }

    /** One session of one node: what it is asked, and which record carries it. */
    interface NodeJob {
      /** The node's own id, which names its revisions and its session. */
      readonly id: string
      /** The record this session's first turn takes: `id`, or a revision of it. */
      readonly recordId: string
      readonly spec: NodeSpec
      readonly outputPaths: Record<string, string>
      readonly firstMessage: string
      /** Explicit for a revision; read from the plan and the reads otherwise. */
      readonly parents?: readonly string[]
      // Reopen this session rather than start one: the node carries on from
      // its last turn. A token that will not open throws `SessionGone`.
      readonly resume?: string
      readonly onHold?: (opened: OpenNode) => void
    }

    // Where a replayed node and a fresh one part, and the only place they do:
    // everything about paths, parents, ids and results is settled here for
    // both, so neither path keeps bookkeeping of its own.
    async function runNode(
      id: string,
      spec: NodeSpec,
      onHold?: (opened: OpenNode) => void
    ): Promise<NodeResult> {
      // Pause gates scheduling; a cancelled run schedules nothing.
      while (pauseAsked()) await sleep(pollMs)
      if (cancelAsked()) throw new Error('the run was cancelled')

      if (taken.has(id)) throw new Error(`duplicate node id "${id}"`)
      taken.add(id)
      for (const read of spec.reads ?? []) {
        if (!existsSync(read)) throw new Error(`node "${id}": required input missing: ${read}`)
      }

      const outputPaths: Record<string, string> = {}
      for (const [name, output] of Object.entries(spec.outputs ?? {})) {
        outputPaths[name] = join(artifacts, output.file)
      }

      // A resumed run replays what the previous life completed. Anything else
      // — a node the quit cut down, one that failed, one this definition never
      // ran before — goes back to work below.
      //
      // The record chain is the single answer to "is this node done", for a
      // plain node exactly as for a held-open one. A clean restart leaves the
      // base record `interrupted` for good and puts the completion on a
      // revision, so a check that read the base alone would send finished
      // work back to a paid session.
      const recorded = replay ? furthestComplete(id) : undefined
      if (recorded !== undefined) {
        return replayed(id, recorded, spec, outputPaths, onHold)
      }
      // Nothing of this node completed, so what goes back to work is the
      // furthest record its session took — a revision, if the stop caught
      // one mid-flight.
      const furthest = replay ? chainOf(id).at(-1) : undefined

      // The workflow's prompt, byte for byte. The engine appends nothing of
      // its own to it: no input list, no output paths, no schema, no
      // reminder to finish. What the workflow file says is what the node
      // is told, so an author can read the file and know.
      const lost = monitors?.takeLost(nodeOwner(id)) ?? []
      const task = [spec.prompt, ...(lost.length === 0 ? [] : [lostMonitorsNotice(lost)])].join(
        '\n\n'
      )
      const fresh = (): Promise<NodeResult> =>
        liveNode({
          id,
          recordId: id,
          spec,
          outputPaths,
          firstMessage: task,
          ...(onHold === undefined ? {} : { onHold })
        })

      // A node that never started, on a resumed run or not, is simply run. A
      // complete record is never stopped: whichever record of the chain
      // carried the completion, it was replayed above.
      const stopped =
        furthest === undefined ||
        furthest.status === 'pending' ||
        furthest.status === 'complete'
          ? undefined
          : furthest
      if (stopped === undefined) return fresh()

      // The node the stop cut down. Its own session holds its work, so it
      // continues from its last turn, keeping its record and its spend.
      if (resumed === 'continue' && stopped.sessionToken !== undefined) {
        try {
          return await liveNode({
            id,
            recordId: stopped.id,
            spec,
            outputPaths,
            firstMessage: [
              CONTINUED_NODE_MESSAGE,
              ...(lost.length === 0 ? [] : [lostMonitorsNotice(lost)])
            ].join('\n\n'),
            resume: stopped.sessionToken,
            ...(onHold === undefined ? {} : { onHold })
          })
        } catch (cause) {
          if (!(cause instanceof SessionGone)) throw cause
          log?.({
            event: 'node_session_unreadable',
            runId: run.id,
            nodeId: stopped.id,
            message: cause.message
          })
        }
      }

      // A clean restart, or a stopped node with no session to reopen: run
      // again from the prompt, under a revision id, so the transcript of the
      // attempt that stopped stays readable beside it.
      const restartId = nextRevisionId(run.nodes, id)
      log?.({
        event: 'node_clean_restart',
        runId: run.id,
        nodeId: stopped.id,
        recordId: restartId,
        asked: resumed === 'clean-restart'
      })
      return liveNode({
        id,
        recordId: restartId,
        spec,
        outputPaths,
        parents: [...new Set([stopped.id, ...stopped.parents])],
        firstMessage: [task, RESTART_NOTICE].join('\n\n'),
        ...(onHold === undefined ? {} : { onHold })
      })
    }

    /**
     * A node the previous life completed, handed back from its record: the
     * outputs where they were written, the recorded verdict and summary. No
     * session is opened, nothing is spent, and the record is left exactly as
     * that life wrote it.
     */
    function replayed(
      id: string,
      record: LiveNode,
      spec: NodeSpec,
      outputPaths: Record<string, string>,
      onHold?: (opened: OpenNode) => void
    ): NodeResult {
      // Fed exactly as a fresh node feeds it, so edges inferred from artifact
      // dataflow come out the same on a resumed run as on a first one.
      for (const path of Object.values(outputPaths)) producerByArtifact.set(path, record.id)
      const result: NodeResult = {
        outputs: outputPaths,
        verdict: record.verdict,
        summary: record.summary ?? ''
      }
      if (onHold !== undefined) onHold(replayedHandle(id, record, spec, outputPaths, result))
      return result
    }

    /**
     * The handle a replayed `openNode` hands back. The first `revise()`
     * reopens the session the node's record names — same context, a new
     * revision record — and every later one goes into that session through
     * the ordinary machinery. A record with no session to reopen gets a
     * fresh one, told what it is picking up. `close()` has nothing of its
     * own to release.
     */
    function replayedHandle(
      id: string,
      record: LiveNode,
      spec: NodeSpec,
      outputPaths: Record<string, string>,
      result: NodeResult
    ): OpenNode {
      let live: OpenNode | undefined
      return {
        result,
        get id() {
          return live?.id ?? record.id
        },
        async revise(message: string, opts?: ReviseOptions): Promise<NodeResult> {
          if (live !== undefined) return live.revise(message, opts)
          const revisionId = nextRevisionId(run.nodes, id)
          const parents = [
            ...new Set([record.id, ...keptParents(run, revisionId, opts?.from ?? [])])
          ]
          const open = (token?: string): Promise<OpenNode> =>
            new Promise<OpenNode>((resolve, reject) => {
              track(
                liveNode({
                  id,
                  recordId: revisionId,
                  spec,
                  outputPaths,
                  parents,
                  firstMessage:
                    token === undefined
                      ? [spec.prompt, RESTART_NOTICE, message].join('\n\n')
                      : [CONTINUED_NODE_MESSAGE, message].join('\n\n'),
                  ...(token === undefined ? {} : { resume: token }),
                  onHold: resolve
                })
              ).catch(reject)
            })
          // Opening without a token is a from-the-prompt re-run, which the
          // direct path logs and this one owes the log too: the record has no
          // session to reopen (every record written before sessions outlived
          // the app), or the one it named would not open. Nobody asked for
          // it, so `asked` is false.
          const restarting = (): void => {
            log?.({
              event: 'node_clean_restart',
              runId: run.id,
              nodeId: record.id,
              recordId: revisionId,
              asked: false
            })
          }
          let opened: OpenNode
          if (record.sessionToken === undefined) {
            restarting()
            opened = await open()
          } else {
            try {
              opened = await open(record.sessionToken)
            } catch (cause) {
              if (!(cause instanceof SessionGone)) throw cause
              log?.({
                event: 'node_session_unreadable',
                runId: run.id,
                nodeId: record.id,
                message: cause.message
              })
              restarting()
              opened = await open()
            }
          }
          live = opened
          return opened.result
        },
        close() {
          live?.close()
        }
      }
    }

    function nodeOwner(id: string): Extract<MonitorOwner, { kind: 'node' }> {
      return { kind: 'node', runId: run.id, nodeId: id }
    }

    async function liveNode(job: NodeJob): Promise<NodeResult> {
      const { id, spec, outputPaths } = job
      const owner = nodeOwner(id)

      /** What the node says it will write, before it has written any of it. */
      const declaredArtifacts = (): RunArtifact[] =>
        Object.entries(spec.outputs ?? {}).map(([name, output]) => ({
          name,
          path: outputPaths[name],
          desc: output.desc
        }))

      // The record this session's first turn takes over: the plan's ghost, or
      // — on a resumed run — whatever the previous life left under this id
      // and never completed. One record per id, whichever life wrote it, so
      // the slot is found by id alone: a second record under one id is a
      // state `chainOf`, `nextRevisionId`, the transcript store and the run
      // graph all take to be impossible. A complete record is nobody's to
      // take over — that work is replayed, not redone — and this throws
      // before a session is opened, so the refusal costs nothing.
      const slot = run.nodes.findIndex((candidate) => candidate.id === job.recordId)
      const held = slot >= 0 ? run.nodes[slot] : undefined
      if (held?.status === 'complete') {
        throw new Error(`node "${job.recordId}" is already complete in this run`)
      }
      // The spec's own declaration wins the moment the node starts; failing
      // that the plan's forecast stands, because a record rebuilt from
      // inference alone would erase edges the workflow already got right.
      const forecast = held?.parents ?? []
      const declared =
        job.parents !== undefined
          ? [...job.parents]
          : spec.from === undefined
            ? forecast
            : keptParents(run, job.recordId, spec.from)
      // Reading an artifact may reveal an edge nobody declared; it never
      // takes one away, so this is a union in every case.
      const inferred = (spec.reads ?? [])
        .map((path) => producerByArtifact.get(path))
        .filter((producer): producer is string => producer !== undefined)
      const parents = [...new Set([...declared, ...inferred])].filter(
        (parent) => parent !== job.recordId
      )
      for (const path of Object.values(outputPaths)) producerByArtifact.set(path, job.recordId)

      // What the previous life already burned under this id. Kept, so a
      // continued node adds to it rather than erasing money that was really
      // spent; a revision starts its own record and carries nothing.
      let carried = {
        cost: held?.cost ?? 0,
        cacheMisses: held?.cacheMisses ?? 0,
        toolCalls: held?.toolCalls ?? 0
      }

      const model = await modelFor(spec.model ?? defaultModel, { runId: run.id, nodeId: id })

      // --- the two injected tools ----------------------------------------
      let completion: { summary: string; verdict?: unknown } | undefined
      let blockerRaised: { reason: string; details?: string; artifact?: string } | undefined

      // Resolved against the run's own worktree, so the project-local origin
      // is the branch this run is working on.
      const nodeSkills = narrowSkills((await skills?.resolve(cwd)) ?? [], spec.skills)

      // The record currently carrying this session; revisions swap it. It is
      // assigned below, once there is a session to carry.
      let node: LiveNode

      // Opened before the record is touched, so a session that will not
      // reopen leaves the stopped node exactly as it stood and the caller can
      // restart it instead.
      const session: NodeSession = await sessions
        .start({
          cwd,
          model,
          sessionDir: store.sessionDir(run.id),
          ...(job.resume === undefined ? {} : { resumeToken: job.resume }),
          nodeId: id,
          // The workflow's system prompt or none; the engine writes neither
          // a role nor a standing prompt for a node.
          ...(spec.system === undefined ? {} : { system: spec.system }),
          tools: spec.tools ?? DEFAULT_TOOLS,
          skills: nodeSkills,
          ...(monitors === undefined ? {} : { monitors: monitors.tools(owner, cwd) }),
          ...(spec.verdict === undefined ? {} : { verdictSchema: spec.verdict }),
          onComplete(done) {
            completion = {
              summary: done.summary,
              ...(done.verdict === undefined ? {} : { verdict: done.verdict })
            }
            return 'Completion recorded. End your turn now.'
          },
          onBlocker(blocker) {
            blockerRaised = blocker
            return 'Blocker recorded. End your turn and wait for a response.'
          },
          // A miss inside a run marks the chip and enters the ledger. It never
          // becomes a message to the orchestrator: nobody is asked
          // about it, and the evidence is read later.
          onCacheMiss(miss) {
            node.cacheMisses = (node.cacheMisses ?? 0) + 1
            save(run)
            void cache?.append({
              at: nowIso(),
              source: {
                kind: 'run',
                runId: run.id,
                workflow: run.workflow,
                node: node.id,
                // The workspace the run belongs to, not the worktree it works in.
                workspace: run.workspacePath
              },
              provider: miss.provider,
              model: miss.model,
              ...(miss.thinkingLevel === undefined ? {} : { thinkingLevel: miss.thinkingLevel }),
              tokensRebilled: miss.tokensRebilled,
              dollarsRebilled: miss.dollarsRebilled,
              gapMs: miss.gapMs,
              changed: miss.changed
            })
          }
        })
        .catch((cause: unknown) => {
          if (job.resume === undefined) throw cause
          throw new SessionGone(cause instanceof Error ? cause.message : String(cause))
        })

      const token = session.token()
      node = {
        id: job.recordId,
        status: 'running',
        parents,
        model,
        reads: (spec.reads ?? []).map((path) => ({
          name: basename(path),
          path,
          desc: 'input'
        })),
        artifacts: declaredArtifacts(),
        startedAt: held?.startedAt ?? nowIso(),
        // The carried money is on the record from the first instant, not from
        // the first stats capture: a node that blocks before it reports any
        // activity never gets one, and until then the record would claim the
        // previous life spent nothing.
        ...(carried.cost === 0 ? {} : { cost: round4(carried.cost) }),
        ...(carried.cacheMisses === 0 ? {} : { cacheMisses: carried.cacheMisses }),
        ...(carried.toolCalls === 0 ? {} : { toolCalls: carried.toolCalls }),
        ...(token === undefined ? {} : { sessionToken: token })
      }
      if (slot >= 0) run.nodes[slot] = node
      else run.nodes.push(node)
      save(run)

      let abortedTurn: 'pause' | 'watchdog' | undefined

      const interruptForPause = (): void => {
        if (!session.isStreaming()) return
        abortedTurn = 'pause'
        void session.abort().catch(() => {})
      }
      handle.pauseInterrupts.add(interruptForPause)

      // One session can back several node records (the original plus its
      // revisions); each record reports its own delta of the session totals.
      // A reopened session reports what it spent before the quit too, so its
      // base is taken the moment it opens and the record's own carried
      // figures stand: nothing is counted twice, whichever way the session
      // accounts for its past.
      const opened = job.resume === undefined ? undefined : session.stats()
      let statBase = { toolCalls: opened?.toolCalls ?? 0, cost: opened?.cost ?? 0 }
      let sessionStats = { ...statBase }

      // The first observation, never the last write: a stamp is set once and
      // never removed, so a file deleted after the fact does not un-write it.
      const stampWritten = (): void => {
        for (const [at, artifact] of node.artifacts.entries()) {
          if (artifact.writtenAt !== undefined) continue
          if (onDisk(artifact.path)) node.artifacts[at] = { ...artifact, writtenAt: nowIso() }
        }
      }

      // `final` is for the last capture of a session: the transcript is read
      // here rather than when the store gets round to writing it, because the
      // session is about to go away. Every other capture hands the store a
      // way to read it later, so a node reporting activity ten times a second
      // costs ten cheap calls and one write.
      const captureStats = (final = false): void => {
        stampWritten()
        const stats = session.stats()
        sessionStats = { toolCalls: stats.toolCalls, cost: stats.cost ?? 0 }
        node.toolCalls = carried.toolCalls + Math.max(0, sessionStats.toolCalls - statBase.toolCalls)
        if (stats.cost !== undefined) {
          node.cost = round4(carried.cost + Math.max(0, stats.cost - statBase.cost))
        }
        if (stats.contextPercent !== undefined) node.contextPercent = stats.contextPercent
        const recordId = node.id
        if (final) {
          const items = session.transcript()
          store.writeTranscript(run.id, recordId, () => items)
        } else {
          store.writeTranscript(run.id, recordId, () => session.transcript())
        }
      }

      let snapshotTimer: ReturnType<typeof setTimeout> | undefined
      const offActivity = session.onActivity((doing) => {
        node.lastActivityAt = nowIso()
        if (doing === undefined) delete node.now
        else node.now = doing
        if (snapshotTimer !== undefined) clearTimeout(snapshotTimer)
        snapshotTimer = setTimeout(() => {
          captureStats()
          save(run)
        }, 300)
      })

      const openRevision = (from: string[] | undefined): void => {
        const revisionId = nextRevisionId(run.nodes, id)
        const revisionParents = [
          ...new Set([node.id, ...keptParents(run, revisionId, from ?? [])])
        ]
        // The record being left behind gets its last transcript now: what
        // this session says from here belongs to the revision.
        captureStats(true)
        statBase = { ...sessionStats }
        // A revision is its own record from zero: what the record it follows
        // burned stays on that record.
        carried = { cost: 0, cacheMisses: 0, toolCalls: 0 }
        const previous = node
        node = {
          id: revisionId,
          status: 'running',
          parents: revisionParents,
          ...(previous.model === undefined ? {} : { model: previous.model }),
          reads: [...previous.reads],
          // The same paths again, unwritten: a revision writes them afresh, and
          // the rail shows one row per path backed by the furthest copy.
          artifacts: declaredArtifacts(),
          startedAt: nowIso(),
          lastActivityAt: nowIso()
        }
        run.nodes.push(node)
        save(run)
      }

      // Watchdog: a hung tool call never ends its turn, so prolonged total
      // silence aborts the turn and the loop takes it from there.
      let nudges = 0
      const watchdog = setInterval(() => {
        if (!session.isStreaming()) return
        const lastActivity = node.lastActivityAt ?? node.startedAt
        const quiet = Date.now() - (lastActivity === undefined ? Date.now() : Date.parse(lastActivity))
        if (quiet > quietAbortMs) {
          abortedTurn = 'watchdog'
          node.now = 'aborting hung tool call…'
          save(run)
          void session.abort().catch(() => {})
        }
      }, watchdogMs)

      let finished = false
      const finishNode = (status: RunNodeStatus, error?: string): void => {
        if (finished) return
        finished = true
        handle.live.delete(control)
        handle.pauseInterrupts.delete(interruptForPause)
        if (releasedBecause !== 'quitting') monitors?.release(owner)
        delete node.now
        delete node.waitingOn
        if (node.endedAt === undefined || node.status !== status) node.endedAt = nowIso()
        node.status = status
        if (error !== undefined) node.error = error
        offActivity()
        clearInterval(watchdog)
        if (snapshotTimer !== undefined) clearTimeout(snapshotTimer)
        captureStats(true)
        session.dispose()
        save(run)
      }

      let releasedBecause: ReleaseReason | undefined

      // Runner-owned release: the workflow is expected to close() a held-open
      // node but cannot be trusted to — the engine backstops the session.
      const control = {
        async release(why: ReleaseReason): Promise<void> {
          if (finished) return
          releasedBecause ??= why
          if (releasedBecause === 'run-ended') monitors?.release(owner)
          if (parked) {
            parkResolve?.({ type: 'close' })
            return
          }
          await session.abort().catch(() => {})
        },
        forceDispose(why: ReleaseReason): void {
          releasedBecause ??= why
          finishNode('failed', RELEASED_ON_RUN_END)
        }
      }
      handle.live.add(control)

      const bailIfReleased = (): void => {
        if (releasedBecause === undefined) return
        finishNode('failed', RELEASED_ON_RUN_END)
        throw new Error(`node "${node.id}" was released when the run ended`)
      }

      /** Park in an attention state until the orchestrator answers. */
      const waitForAnswer = async (status: 'blocked' | 'stalled'): Promise<string> => {
        node.status = status
        const reason =
          status === 'blocked'
            ? (blockerRaised?.reason ?? 'blocked')
            : 'went quiet without completing, nudges exhausted — needs a corrective instruction'
        run.question = { reason, nodeId: node.id, raisedAt: nowIso() }
        // Registered before the save, so the record that goes out already
        // says somebody owes this run an answer.
        const pending = awaitAnswer(handle)
        save(run)
        tell(
          run,
          [
            `${runMessageHeader(run)} ${
              status === 'blocked' ? 'raised a blocker' : 'stalled'
            } at node "${node.id}":`,
            '',
            reason,
            ...(blockerRaised?.details === undefined ? [] : ['', blockerRaised.details]),
            ...(blockerRaised?.artifact === undefined
              ? []
              : ['', `Read this document before deciding: ${blockerRaised.artifact}`]),
            '',
            `Answer with the crucible_answer tool (runId "${run.id}"). Answer from your own ` +
              'context when you can; bring it to the user when it needs their judgment.'
          ].join('\n')
        )
        try {
          const answer = await pending
          node.status = 'running'
          if (run.question !== undefined && run.question.answeredAt === undefined) {
            run.question.answeredAt = nowIso()
            run.question.answer = answer
          }
          save(run)
          return answer
        } catch (cause) {
          bailIfReleased()
          throw cause
        }
      }

      const validate = async (): Promise<string[]> => {
        const problems: string[] = []
        for (const [name, path] of Object.entries(outputPaths)) {
          if (!existsSync(path) || statSync(path).size === 0) {
            problems.push(`required output "${name}" is missing or empty: ${path}`)
          }
        }
        stampWritten()
        let verdict: unknown = undefined
        if (spec.verdict !== undefined) {
          // Tolerant decode: some models pass the verdict as a JSON-encoded
          // string. Unwrap before validating.
          if (typeof completion?.verdict === 'string') {
            try {
              const parsed: unknown = JSON.parse(completion.verdict)
              if (checkVerdict(spec.verdict, parsed).length === 0) completion.verdict = parsed
            } catch {
              // Leave as-is; validation below reports the mismatch.
            }
          }
          if (completion?.verdict === undefined) {
            problems.push('complete_node was called without the required `verdict` argument')
          } else {
            const mismatches = checkVerdict(spec.verdict, completion.verdict)
            if (mismatches.length > 0) {
              problems.push(
                `verdict does not match the declared schema: ${mismatches.slice(0, 3).join('; ')}. ` +
                  'Pass `verdict` as a plain JSON object argument, not a JSON-encoded string.'
              )
            } else {
              verdict = completion.verdict
            }
          }
        }
        if (spec.check !== undefined) {
          // The file's own function, run where the file lives; a host that
          // dies under it rejects, which reads as the check throwing. It is
          // handed the verdict only once the verdict validated, so a lint can
          // hold a document to the word the agent gave.
          try {
            problems.push(...(await spec.check(outputPaths, verdict)))
          } catch (cause) {
            problems.push(
              `deterministic check threw: ${cause instanceof Error ? cause.message : String(cause)}`
            )
          }
        }
        return problems
      }

      // --- the loop -------------------------------------------------------
      type HoldDirective =
        | { type: 'close' }
        | {
            type: 'revise'
            message: string
            from?: string[]
            waiter: { resolve: (result: NodeResult) => void; reject: (cause: unknown) => void }
          }
      let parkResolve: ((directive: HoldDirective) => void) | undefined
      let parked = false
      let reviseWaiter:
        | { resolve: (result: NodeResult) => void; reject: (cause: unknown) => void }
        | undefined
      let handleGiven = false
      let message = job.firstMessage
      let validationRetries = 0

      try {
        for (;;) {
          await session.prompt(message)
          const aborted = abortedTurn
          abortedTurn = undefined
          bailIfReleased()

          if (blockerRaised !== undefined) {
            const answer = await waitForAnswer('blocked')
            blockerRaised = undefined
            message =
              `Response to your blocker:\n\n${answer}\n\n` +
              'Continue the task. Call raise_blocker again if still stuck, and complete_node when done.'
            continue
          }

          if (completion !== undefined) {
            const problems = await validate()
            if (problems.length === 0) {
              node.verdict = completion.verdict
              node.summary = completion.summary
              for (const path of Object.values(outputPaths)) {
                producerByArtifact.set(path, node.id)
              }
              const result: NodeResult = {
                outputs: outputPaths,
                verdict: completion.verdict,
                summary: completion.summary
              }
              if (job.onHold === undefined) {
                finishNode('complete')
                return result
              }
              // Hold open: complete, but the session stays alive so feedback
              // can re-enter the same context via revise().
              node.status = 'complete'
              node.endedAt = nowIso()
              delete node.now
              captureStats()
              save(run)

              reviseWaiter?.resolve(result)
              reviseWaiter = undefined
              parked = true
              const directive = await new Promise<HoldDirective>((resolve) => {
                parkResolve = resolve
                if (!handleGiven) {
                  handleGiven = true
                  // Never absent here: a node with no `onHold` returned above
                  // rather than parking.
                  job.onHold?.({
                    result,
                    get id() {
                      return node.id
                    },
                    revise: (text: string, opts?: ReviseOptions) =>
                      new Promise<NodeResult>((resolveRevise, rejectRevise) =>
                        parkResolve?.({
                          type: 'revise',
                          message: text,
                          ...(opts?.from === undefined ? {} : { from: opts.from }),
                          waiter: { resolve: resolveRevise, reject: rejectRevise }
                        })
                      ),
                    close: () => parkResolve?.({ type: 'close' })
                  })
                }
              })
              parked = false
              // A release racing an in-flight revise() wins: the run is over.
              if (directive.type === 'close' || releasedBecause !== undefined) {
                finishNode('complete')
                return result
              }
              reviseWaiter = directive.waiter
              openRevision(directive.from)
              completion = undefined
              validationRetries = 0
              message = directive.message
              continue
            }
            completion = undefined
            validationRetries += 1
            if (validationRetries >= VALIDATION_RETRY_LIMIT) {
              finishNode(
                'failed',
                `output validation failed ${VALIDATION_RETRY_LIMIT}x: ${problems.join('; ')}`
              )
              throw new Error(`node "${id}" failed validation: ${problems.join('; ')}`)
            }
            message =
              `Your completion was rejected:\n${problems.map((p) => `- ${p}`).join('\n')}\n\n` +
              'Fix these problems, then call complete_node again.'
            continue
          }

          const waiting = aborted === undefined ? monitors?.wait(owner) : undefined
          if (waiting !== undefined) {
            node.waitingOn = waiting.on
            save(run)
            const parkedNode = node
            let parkedOnWake = true
            const followPause = async (): Promise<void> => {
              while (parkedOnWake && !finished && releasedBecause === undefined) {
                const wanted = pauseAsked() ? 'paused' : 'running'
                if (
                  parkedNode.status !== wanted &&
                  (parkedNode.status === 'running' || parkedNode.status === 'paused')
                ) {
                  parkedNode.status = wanted
                  save(run)
                }
                await sleep(pollMs)
              }
            }
            void followPause()
            let woken: { readonly text: string }
            try {
              woken = await waiting.wake
            } catch (cause) {
              parkedOnWake = false
              delete node.waitingOn
              save(run)
              bailIfReleased()
              throw cause
            }
            delete node.waitingOn
            while (pauseAsked() && releasedBecause === undefined) {
              bailIfReleased()
              await sleep(pollMs)
            }
            parkedOnWake = false
            if (node.status === 'paused') node.status = 'running'
            bailIfReleased()
            node.lastActivityAt = nowIso()
            save(run)
            message = woken.text
            continue
          }

          // Pause parks the node between turns; the interrupter aborted any
          // in-flight turn. Completed or blocked work above is honored first.
          if (pauseAsked() && releasedBecause === undefined) {
            node.status = 'paused'
            delete node.now
            save(run)
            while (pauseAsked()) {
              bailIfReleased()
              await sleep(pollMs)
            }
            bailIfReleased()
            node.status = 'running'
            node.lastActivityAt = nowIso()
            save(run)
            message =
              'Your work was paused by a human and has now been resumed. Reassess where you were ' +
              'and continue the task. Call complete_node when done or raise_blocker if stuck.'
            continue
          }

          if (aborted === 'watchdog') {
            message =
              `Your work was interrupted: no activity for ${Math.round(quietAbortMs / 60000)}+ ` +
              'minutes — almost certainly a hung or runaway tool call. The in-flight call was ' +
              'aborted. Use bounded, targeted commands. Reassess where you were and continue the task.'
            continue
          }

          // Neither completed nor blocked: nudge, then stall out to the
          // orchestrator.
          nudges += 1
          save(run)
          if (nudges <= NUDGE_LIMIT) {
            message =
              'You stopped without resolving this node. If the work is done, call complete_node. ' +
              'If you are stuck or need a human, call raise_blocker. Otherwise, continue the task.'
            continue
          }
          const answer = await waitForAnswer('stalled')
          nudges = 0
          message =
            `Your work went quiet and was reviewed. The response:\n\n${answer}\n\n` +
            'Continue. Call complete_node when done or raise_blocker if stuck.'
        }
      } catch (cause) {
        reviseWaiter?.reject(cause)
        if (node.status === 'running') {
          finishNode('failed', cause instanceof Error ? cause.message : String(cause))
        }
        throw cause
      }
    }

    /** One key, once per run: asking for it twice is the workflow's mistake. */
    function claimEffect(key: string): void {
      if (effectsClaimed.has(key)) throw new Error(`duplicate effect id "${key}"`)
      effectsClaimed.add(key)
    }

    /** What this run recorded under a key, for a resumed run to be handed. */
    function recordedEffect(key: string): RecordedEffect {
      claimEffect(key)
      const already = recordedEffects.get(key)
      if (already === undefined) return { replayed: false }
      log?.({ event: 'effect_replayed', runId: run.id, key })
      return { replayed: true, value: already.value }
    }

    /** The second half of an effect: the value the work just produced. */
    function recordEffect(key: string, value: unknown): void {
      if (effectsRecorded.has(key)) throw new Error(`duplicate effect id "${key}"`)
      // Claimed already by the lookup half that precedes it; claimed here for
      // a caller that skipped that half.
      if (!effectsClaimed.has(key)) claimEffect(key)
      effectsRecorded.add(key)
      run.effects = [...(run.effects ?? []), { key, value, at: nowIso() }]
      save(run)
    }

    /** A workflow-level question. The run stays `running` while parked. */
    async function ask(question: {
      reason: string
      artifacts?: Record<string, string>
    }): Promise<string> {
      if (cancelAsked()) throw new Error('the run was cancelled')
      // A check-in the run already had answered is not asked again: the
      // orchestrator answered it once, and on a resume it is handed back.
      const key = `·ask·${(asks += 1)}`
      const already = recordedEffect(key)
      if (already.replayed) return String(already.value)
      run.question = { reason: question.reason, raisedAt: nowIso() }
      const pending = awaitAnswer(handle)
      save(run)
      const artifactLines = Object.entries(question.artifacts ?? {}).map(
        ([name, path]) => `- ${name}: ${path}`
      )
      tell(
        run,
        [
          `${runMessageHeader(run)} is checking in:`,
          '',
          question.reason,
          ...(artifactLines.length === 0 ? [] : ['', 'Documents that come with it:', ...artifactLines]),
          '',
          `Answer with the crucible_answer tool (runId "${run.id}"). Answer from your own ` +
            'context when you can; bring it to the user when it needs their judgment.'
        ].join('\n')
      )
      const answer = await pending
      if (run.question !== undefined && run.question.answeredAt === undefined) {
        run.question.answeredAt = nowIso()
        run.question.answer = answer
      }
      recordEffect(key, answer)
      save(run)
      return answer
    }

    /**
     * A message to the orchestrator that waits for nothing: no question on
     * the record, no waiter, the run view shows no check-in. Recorded once
     * said, so a resumed run does not say it again.
     */
    async function notify(message: {
      reason: string
      artifacts?: Record<string, string>
    }): Promise<void> {
      if (cancelAsked()) throw new Error('the run was cancelled')
      const key = `·notify·${(notifies += 1)}`
      if (recordedEffect(key).replayed) return
      const artifactLines = Object.entries(message.artifacts ?? {}).map(
        ([name, path]) => `- ${name}: ${path}`
      )
      tell(
        run,
        [
          `${runMessageHeader(run)} reports:`,
          '',
          message.reason,
          ...(artifactLines.length === 0 ? [] : ['', 'Documents that come with it:', ...artifactLines]),
          '',
          'This is for your information: the run is not waiting on an answer and continues on ' +
            'its own. Act on it from your own context, or bring it to the user when it needs them.'
        ].join('\n')
      )
      // There is no answer to keep; the record marks only that this was said.
      recordEffect(key, null)
    }

    const ctx: EngineContext = {
      inputs: run.inputs,
      artifactDir: artifacts,
      cwd,
      node: (id, spec) => track(runNode(id, spec)),
      openNode: (id, spec) =>
        new Promise<OpenNode>((resolve, reject) => {
          track(runNode(id, spec, resolve)).catch(reject)
        }),
      ask,
      notify,
      async recordedEffect(id) {
        return recordedEffect(id)
      },
      async recordEffect(id, value) {
        recordEffect(id, value)
      },
      derive: async (path, fromNodeId) => {
        if (!run.nodes.some((candidate) => candidate.id === fromNodeId)) {
          throw new Error(`derive("${path}"): no node "${fromNodeId}" in this run`)
        }
        producerByArtifact.set(path, fromNodeId)
      },
      // Resolved now, through the origin ladder, so an unknown name fails the
      // staging run rather than a successor nobody is watching (Q25).
      stage: async (opts) => {
        const target = await loader.resolve(run.workspacePath, opts.workflow)
        handle.staged.push({ workflow: target.name, inputs: { ...opts.inputs } })
        return `${run.id}→${target.name}`
      }
    }

    // The outcome is held here until the run has genuinely finished: sessions
    // released, worktree committed. Publishing earlier would make the record
    // lie in exactly the window a chain acts on.
    let outcome: 'complete' | 'failed' | 'cancelled'
    try {
      const outputs = await host.run(ctx)
      outcome = 'complete'
      if (outputs !== undefined) run.outputs = outputs
    } catch (cause) {
      outcome = handle.cancelRequested ? 'cancelled' : 'failed'
      if (!handle.cancelRequested) {
        run.error = cause instanceof Error ? cause.message : String(cause)
      }
    }
    // The file has said its last, however it ended; its process goes with it.
    host.kill()

    await releaseLiveNodes(handle, 'run-ended')
    rejectWaiters(handle, 'the run ended')
    if (outcome === 'complete') {
      // Ghosts that never materialized were branches not taken.
      run.nodes = run.nodes.filter((node) => node.status !== 'pending')
    }

    // However the run ended, its work survives as a commit on its own branch
    // — unless the workflow said it commits for itself. Never merged, never
    // pushed: bringing the work back is the orchestrator's judgment.
    let committed = false
    if (manifest.commit !== false && run.worktreePath !== undefined) {
      try {
        const landed = await commitRunWorktree(
          run.worktreePath,
          `crucible: ${run.workflow} ${run.id}`
        )
        run.finalCommit = landed.commit
        committed = landed.committed
      } catch (cause) {
        const failure = cause instanceof Error ? cause.message : String(cause)
        run.error = run.error === undefined ? failure : `${run.error}; ${failure}`
        if (outcome === 'complete') outcome = 'failed'
      }
    }

    run.status = outcome
    run.endedAt = nowIso()
    save(run)
    handles.delete(run.id)
    log?.({ event: 'run_ended', runId: run.id, status: outcome })

    tell(run, endingText(run, outcome, committed))

    // Chains: successors start directly on clean completion, continuing this
    // run's branch from its final commit.
    if (outcome === 'complete') {
      for (const staged of handle.staged) {
        try {
          await startInternal(
            {
              workspacePath: run.workspacePath,
              workspaceName: run.workspaceName,
              ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
              // A successor of a scheduled run came from that fire too, so it
              // lands on the same board and parks where its predecessor would.
              ...(run.scheduled === true ? { scheduled: true } : {}),
              workflow: staged.workflow,
              inputs: staged.inputs,
              base: run.finalCommit ?? run.baseCommit ?? 'HEAD'
            },
            { ...(run.branch === undefined ? {} : { branch: run.branch }), after: run.id }
          )
        } catch (cause) {
          tell(
            run,
            `${runMessageHeader(run)} staged a "${staged.workflow}" run that ` +
              `could not start: ${cause instanceof Error ? cause.message : String(cause)}`
          )
        }
      }
    }
  }

  /** However the workflow ended, no agent session outlives it. */
  async function releaseLiveNodes(handle: Handle, why: ReleaseReason): Promise<void> {
    if (handle.live.size === 0) return
    await Promise.allSettled([...handle.live].map((control) => control.release(why)))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled([...handle.pending]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, releaseWaitMs)
        })
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    for (const control of [...handle.live]) control.forceDispose(why)
  }

  function endingText(run: LiveRun, outcome: RunStatus, committed: boolean): string {
    const where = [
      run.branch === undefined ? undefined : `branch ${run.branch}`,
      run.worktreePath === undefined ? undefined : `worktree ${run.worktreePath}`
    ]
      .filter((part): part is string => part !== undefined)
      .join(' · ')

    if (outcome === 'complete') {
      const outputs =
        run.outputs === undefined ? '' : `\n\nOutputs: ${JSON.stringify(run.outputs, null, 2)}`
      const work = committed
        ? 'Its work is committed on that branch — pull it in when you judge the moment right ' +
          '(merge or cherry-pick; the run never touches your tree). '
        : 'It left no new commits beyond what the workflow committed itself. '
      return (
        `${runMessageHeader(run)} completed · ${where}.` +
        outputs +
        `\n\n${work}` +
        'Tell the user what came back and what you did about it.'
      )
    }
    if (outcome === 'cancelled') {
      return (
        `${runMessageHeader(run)} was cancelled · ${where}. ` +
        'Whatever it had done is committed on its branch; nothing else happens on its own.'
      )
    }
    return (
      `${runMessageHeader(run)} failed · ${where}.\n\n` +
      `${run.error ?? 'No error was recorded.'}\n\n` +
      'Its worktree is left as it stands for inspection. Decide whether to retry, repair, or ' +
      'bring it to the user.'
    )
  }

  // Runs whose resume is in flight: the loader is asked before anything is
  // written, and a second resume arriving in that window is refused rather
  // than allowed to start the same run twice.
  const resuming = new Set<WorkflowRunId>()

  /**
   * Total over every stop short of completion — interrupted, failed,
   * cancelled — and over paused, which un-pauses. The stopped node continues
   * from its last turn in its own session, in the same worktree, reporting to
   * the same orchestrator; completed nodes, answered check-ins and recorded
   * effects are handed back from the record at no cost. A clean restart runs
   * the stopped node again from its prompt instead, as a revision, so the
   * transcript of the attempt that stopped stays readable. A complete or
   * already-running run is refused, and so is a missing worktree or a
   * workflow that no longer resolves — all before anything can cost money.
   */
  async function resumeRun(runId: WorkflowRunId, kind: ResumeKind = 'continue'): Promise<void> {
    const run = requireRecord(runId)
    if (run.status === 'paused') {
      const handle = handles.get(runId)
      // A paused run whose engine went away is a stopped run like any other,
      // and is put back to work below rather than refused.
      if (handle !== undefined) {
        if (handle.desired !== 'paused') return
        handle.desired = 'running'
        handle.run.status = 'running'
        save(handle.run)
        return
      }
    }
    if (!runCanResume(run)) throw new Error(resumeRefusal(runId, run.status))
    if (handles.has(runId) || resuming.has(runId)) {
      throw new Error(resumeRefusal(runId, 'running'))
    }

    resuming.add(runId)
    try {
      // The same worktree is the whole promise of resuming, so a run whose
      // worktree is gone is refused rather than given a new one.
      if (run.worktreePath === undefined || !existsSync(run.worktreePath)) {
        throw new Error(
          `The run "${runId}" cannot resume: its worktree is gone ` +
            `(${run.worktreePath ?? 'none was recorded'}). Resume puts the node it stopped on ` +
            'back to work in the same worktree and never makes a new one.'
        )
      }
      // The loader's own error stands: which workflow file is missing or
      // unloadable is what the reader needs.
      const resolved = await loader.resolve(run.workspacePath, run.workflow)

      // A resumed run keeps its orchestrator; when that session is gone the
      // run goes unattended instead, so its questions park it until a session
      // adopts it. No session is ever created for it.
      if (run.sessionId !== undefined && sessionExists?.(run.sessionId) === false) {
        delete run.sessionId
        // Nothing is owed a notice any more: there is nobody to owe it to.
        delete run.noticePending
      }

      run.status = 'running'
      delete run.error
      delete run.endedAt
      // A run that is working again must show, whatever the user cleared.
      delete run.dismissedAt
      // Nothing is reverted here: a stopped node's own record is what its
      // resume continues from, and `runNode` decides node by node whether
      // it carries on or is restarted.

      const handle: Handle = {
        run,
        host: resolved.open(),
        desired: 'running',
        cancelRequested: false,
        pauseInterrupts: new Set(),
        waiters: [],
        live: new Set(),
        pending: new Set(),
        staged: []
      }
      handles.set(runId, handle)
      save(run)
      log?.({ event: 'run_resumed', runId, workflow: run.workflow, branch: run.branch, kind })

      void execute(handle, resolved.manifest, kind).catch((cause: unknown) => {
        handle.host.kill()
        run.status = 'failed'
        run.error = cause instanceof Error ? cause.message : String(cause)
        run.endedAt = nowIso()
        save(run)
        log?.({ event: 'run_crashed', runId, message: run.error })
      })
    } finally {
      resuming.delete(runId)
    }
  }

  /** Stops a live run where it stands; its record keeps what it reached. */
  function cancelRun(runId: WorkflowRunId): void {
    const handle = handles.get(runId)
    if (handle === undefined) throw new Error(`The run "${runId}" is not live.`)
    if (handle.cancelRequested) return
    handle.desired = 'cancelled'
    handle.cancelRequested = true
    rejectWaiters(handle, 'the run was cancelled')
    void releaseLiveNodes(handle, 'run-ended')
    // The workflow's code is stopped where it stands, whatever it is doing:
    // a file that catches every rejection, or one held in a synchronous
    // call, would otherwise outlive the run it belongs to.
    handle.host.kill()
  }

  return {
    runs(): readonly RunRecord[] {
      return records as readonly RunRecord[]
    },

    start,

    pause(runId: WorkflowRunId): void {
      const handle = handles.get(runId)
      if (handle === undefined) throw new Error(`The run "${runId}" is not live.`)
      if (handle.desired !== 'running') return
      handle.desired = 'paused'
      handle.run.status = 'paused'
      save(handle.run)
      for (const interrupt of [...handle.pauseInterrupts]) interrupt()
    },

    resume: (runId, kind) => resumeRun(runId, kind),

    cancel: cancelRun,

    deliverNotices(sessionId: SessionId): void {
      for (const run of records) {
        if (run.noticePending !== true || run.sessionId !== sessionId) continue
        // Composed here, from the record as it stands: a run resumed since the
        // sweep says so instead of repeating a world that has moved on. A
        // successful tell clears the flag and writes the clear.
        tell(run, interruptionNotice(run as RunRecord))
      }
    },

    dismiss(runId: WorkflowRunId): void {
      const run = requireRecord(runId)
      if (run.status === 'running' || run.status === 'paused') {
        // A run with an orchestrator is stopped from the run view, never
        // cleared: the session it reports to is still listening.
        if (run.sessionId !== undefined) throw new Error(dismissRefusal(runId))
        // A parked run has nobody listening, so dismissing it is the whole
        // act: it stops working and is cleared in one go.
        if (run.dismissedAt === undefined) run.dismissedAt = nowIso()
        save(run)
        cancelRun(runId)
        return
      }
      // The first stamp stands: dismissing twice says nothing new.
      if (run.dismissedAt !== undefined) return
      run.dismissedAt = nowIso()
      // Nobody will resume a dismissed run, so what its nodes were waiting on
      // when the quit hit outlives nothing.
      monitors?.release({ kind: 'run', runId })
      save(run)
    },

    adopt(runId: WorkflowRunId, sessionId: SessionId): void {
      // The record is the run, live or settled: the handle holds the same
      // object, so a live run's next message follows the record's session.
      const run = requireRecord(runId)
      if (run.sessionId === sessionId) return
      run.sessionId = sessionId
      save(run)
      log?.({ event: 'run_adopted', runId, sessionId })
    },

    answer(runId: WorkflowRunId, message: string): void {
      const run = requireRecord(runId)
      const handle = handles.get(runId)
      const waiter = handle?.waiters.shift()
      if (handle === undefined || waiter === undefined) {
        throw new Error(`The run "${runId}" is not waiting on an answer.`)
      }
      run.waiting = handle.waiters.length > 0
      waiter.resolve(message)
      save(run)
    },

    async nodeTranscript(
      runId: WorkflowRunId,
      nodeId: string
    ): Promise<readonly TranscriptItem[]> {
      requireRecord(runId)
      return store.readTranscript(runId, nodeId)
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      for (const handle of handles.values()) {
        handle.cancelRequested = true
        handle.desired = 'cancelled'
        rejectWaiters(handle, 'Crucible is quitting')
        void releaseLiveNodes(handle, 'quitting')
        handle.host.kill()
      }
      // The app is going away, so what the store was going to write next it
      // writes now: a resume reads whatever is on disk at this moment.
      store.flush()
    }
  }
}

// The most honest stop time a swept record can be given. The rule itself lives
// beside the record, because the sidebar reads the same fact about a stopped
// run when it decides which band that run's workspace sits in.
function latestNodeStop(run: LiveRun): string | undefined {
  return latestNodeActivity(run)
}

/**
 * A declaration filtered to the nodes the run actually has, and never the
 * declaring node itself: a parent never points at nothing.
 */
function keptParents(
  run: { nodes: readonly { id: string }[] },
  id: string,
  from: readonly string[]
): string[] {
  const known = new Set(run.nodes.map((candidate) => candidate.id))
  return from.filter((parent) => parent !== id && known.has(parent))
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

/** A file that exists and holds something, which is what "written" means here. */
function onDisk(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).size > 0
  } catch {
    return false
  }
}
