import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { SessionId, TranscriptItem } from '../../shared/agent/port'
import {
  dismissRefusal,
  INTERRUPTED_MESSAGE,
  resumeRefusal,
  runMessageHeader,
  type RunArtifact,
  type RunNodeStatus,
  type RunRecord,
  type RunStatus,
  type WorkflowRunId
} from '../../shared/workflows/run'
import { interruptionNotice } from '../../shared/workflows/status'
import type {
  NodeResult,
  NodeSpec,
  OpenNode,
  ReviseOptions,
  RunContext,
  WorkflowDef
} from './authoring'
import type { CacheRecorder } from '../cache/ledger'
import { narrowSkills, type SkillService } from '../skills/service'
import type { WorkflowLoader } from './loader'
import type { NodeSession, NodeSessionFactory } from './node-session'
import type { RunStore } from './store'
import { checkVerdict } from './verdict'
import { commitRunWorktree, createRunWorktree } from './worktree'

// The engine: executes runs in-process, one seam away from agents. Ported
// from the legacy runner with the venue machinery deleted — every run works
// in a worktree of its own, branched from a commit named at kickoff — and
// the dashboard's answer channel replaced by the orchestrator:
// every check-in, blocker, stall and completion is delivered as a message to
// the run's session agent, and answers come back through crucible_answer.

const DEFAULT_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']

const NUDGE_LIMIT = 2
const VALIDATION_RETRY_LIMIT = 3

// What a revision of a replayed node opens with. The session that held the
// node's context died with the process, so feedback cannot re-enter it: a
// fresh agent is told what it is picking up and where the prior work is.
const REPLAY_REVISION_NOTICE =
  'You are picking this node up in a fresh session: Crucible quit while this run was working, ' +
  'so the earlier conversation is gone, while the worktree and the artifacts hold the work that ' +
  'was already done. Read what is there before you change it.'

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
  // Total over the two stopped states: a paused run un-pauses, an interrupted
  // one re-runs the node the quit cut down, from its beginning, in the same
  // worktree, replaying what already completed at no cost. Every other status
  // is refused with a sentence. Resolves once the run is working again; the
  // run itself continues in the background.
  resume(runId: WorkflowRunId): Promise<void>
  cancel(runId: WorkflowRunId): void
  // Every run of this session that is owed an interruption notice says it now,
  // through the ordinary delivery path. Called by the run service's turn-start
  // hook when a user turn begins, which is the only thing that wakes a session.
  wake(sessionId: SessionId): void
  /** Stamps a settled run dismissed; refuses a live one. Stamping twice is a no-op. */
  dismiss(runId: WorkflowRunId): void
  /** Hands the run to another session: every later message goes there. */
  adopt(runId: WorkflowRunId, sessionId: SessionId): void
  /** The orchestrator's answer to whatever the run is waiting on. */
  answer(runId: WorkflowRunId, message: string): void
  nodeTranscript(runId: WorkflowRunId, nodeId: string): readonly TranscriptItem[]
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

interface Handle {
  readonly run: LiveRun
  desired: 'running' | 'paused' | 'cancelled'
  cancelRequested: boolean
  readonly pauseInterrupts: Set<() => void>
  readonly waiters: Waiter[]
  readonly live: Set<{ release(): Promise<void>; forceDispose(): void }>
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
    const def = resolved.def

    // Every declared input is a path to an existing file, checked before
    // anything costs money; names the workflow never declared are refused so
    // a typo cannot silently drop an input.
    const inputs: Record<string, string> = { ...request.inputs }
    for (const name of Object.keys(inputs)) {
      if (!(name in def.inputs)) {
        throw new Error(`The workflow "${resolved.name}" takes no input named "${name}".`)
      }
    }
    for (const [name, description] of Object.entries(def.inputs)) {
      const path = inputs[name]
      if (path === undefined) {
        throw new Error(`The workflow "${resolved.name}" needs "${name}": ${description}`)
      }
      if (!existsSync(path)) {
        throw new Error(`The input "${name}" names a file that does not exist: ${path}`)
      }
    }

    // Planning doubles as validation: a throw here fails the kickoff.
    const planned = def.plan?.(inputs) ?? []

    const id = mintId()
    const worktree = await createRunWorktree({
      workspacePath: request.workspacePath,
      runId: id,
      base: request.base,
      ...(chain.branch === undefined ? {} : { branch: chain.branch })
    })
    const artifactDir = store.artifactDir(id)

    // The rail's forecast names what the run would spend on now; every node
    // asks again for itself when it starts.
    const plannedModels = await Promise.all(
      planned.map((plan) => modelFor(plan.model ?? defaultModel, { runId: id, nodeId: plan.id }))
    )

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
      inputDescs: { ...def.inputs },
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
    void execute(handle, def).catch((cause: unknown) => {
      run.status = 'failed'
      run.error = cause instanceof Error ? cause.message : String(cause)
      run.endedAt = nowIso()
      save(run)
      log?.({ event: 'run_crashed', runId: id, message: run.error })
    })

    return run as RunRecord
  }

  // `replay` is what a resumed run brings: the record already holds nodes a
  // previous life completed, and those are handed back rather than run again.
  // A first run replays nothing, so nothing about it changes.
  async function execute(handle: Handle, def: WorkflowDef, replay = false): Promise<void> {
    const { run } = handle
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

    const recordOf = (nodeId: string): LiveNode | undefined =>
      run.nodes.find((candidate) => candidate.id === nodeId)

    // The furthest completed record of a held-open node's revision chain:
    // `id`, then `id·rN` by highest N. What a replayed handle's result is.
    function furthestComplete(id: string): LiveNode | undefined {
      const revised = run.nodes
        .filter(
          (candidate) =>
            candidate.status === 'complete' && candidate.id.startsWith(`${id}·r`)
        )
        .map((candidate) => ({
          node: candidate,
          round: Number(candidate.id.slice(id.length + 2))
        }))
        .filter((candidate) => Number.isFinite(candidate.round))
        .sort((left, right) => left.round - right.round)
      const base = recordOf(id)
      return revised.at(-1)?.node ?? (base?.status === 'complete' ? base : undefined)
    }

    /** The next free revision id of a node: `<id>·rN`. */
    function nextRevisionId(id: string): string {
      const known = new Set(run.nodes.map((candidate) => candidate.id))
      let round = 0
      let revisionId: string
      do {
        round += 1
        revisionId = `${id}·r${round}`
      } while (known.has(revisionId))
      return revisionId
    }

    /** One session of one node: what it is asked, and which record carries it. */
    interface NodeJob {
      /** The node's own id, which names its revisions and its role prompt. */
      readonly id: string
      /** The record this session's first turn takes: `id`, or a revision of it. */
      readonly recordId: string
      readonly spec: NodeSpec
      readonly outputPaths: Record<string, string>
      readonly firstMessage: string
      /** Explicit for a revision; read from the plan and the reads otherwise. */
      readonly parents?: readonly string[]
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
      // ran before — runs for real, exactly as a first run would.
      const recorded = !replay
        ? undefined
        : onHold === undefined
          ? recordOf(id)
          : furthestComplete(id)
      if (recorded?.status === 'complete') {
        return replayed(id, recorded, spec, outputPaths, onHold)
      }

      return liveNode({
        id,
        recordId: id,
        spec,
        outputPaths,
        firstMessage: composeTaskPrompt(spec, outputPaths),
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
     * The handle a replayed `openNode` hands back. `revise()` cannot re-enter
     * the session that held this node's context — it died with the process —
     * so the first one opens a fresh revision node told what it is picking up,
     * and every later one goes into that session through the ordinary
     * machinery. `close()` has nothing of its own to release.
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
          const revisionId = nextRevisionId(id)
          const opened = await new Promise<OpenNode>((resolve, reject) => {
            track(
              liveNode({
                id,
                recordId: revisionId,
                spec,
                outputPaths,
                parents: [
                  ...new Set([record.id, ...keptParents(run, revisionId, opts?.from ?? [])])
                ],
                firstMessage: [
                  composeTaskPrompt(spec, outputPaths),
                  REPLAY_REVISION_NOTICE,
                  message
                ].join('\n\n'),
                onHold: resolve
              })
            ).catch(reject)
          })
          live = opened
          return opened.result
        },
        close() {
          live?.close()
        }
      }
    }

    async function liveNode(job: NodeJob): Promise<NodeResult> {
      const { id, spec, outputPaths } = job

      /** What the node says it will write, before it has written any of it. */
      const declaredArtifacts = (): RunArtifact[] =>
        Object.entries(spec.outputs ?? {}).map(([name, output]) => ({
          name,
          path: outputPaths[name],
          desc: output.desc
        }))

      // The record this session's first turn takes over: the plan's ghost, or
      // — on a resumed run — whatever the previous life left under this id
      // and never completed. One record per id, whichever life wrote it.
      const slot = run.nodes.findIndex(
        (candidate) => candidate.id === job.recordId && candidate.status !== 'complete'
      )
      const held = slot >= 0 ? run.nodes[slot] : undefined
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
      // re-run adds to it rather than erasing money that was really spent; a
      // revision starts its own record and carries nothing.
      let carried = { cost: held?.cost ?? 0, cacheMisses: held?.cacheMisses ?? 0 }

      const model = await modelFor(spec.model ?? defaultModel, { runId: run.id, nodeId: id })

      // The record currently carrying this session; revisions swap it.
      let node: LiveNode = {
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
        startedAt: nowIso(),
        // The carried money is on the record from the re-run's first instant,
        // not from its first stats capture: a node that blocks before it
        // reports any activity never gets one, and until then the record
        // would claim the previous life spent nothing.
        ...(carried.cost === 0 ? {} : { cost: round4(carried.cost) }),
        ...(carried.cacheMisses === 0 ? {} : { cacheMisses: carried.cacheMisses })
      }
      if (slot >= 0) run.nodes[slot] = node
      else run.nodes.push(node)
      save(run)

      // --- the two injected tools ----------------------------------------
      let completion: { summary: string; verdict?: unknown } | undefined
      let blockerRaised: { reason: string; details?: string; artifact?: string } | undefined

      // Resolved against the run's own worktree, so the project-local origin
      // is the branch this run is working on.
      const nodeSkills = narrowSkills((await skills?.resolve(cwd)) ?? [], spec.skills)

      const session: NodeSession = await sessions.start({
        cwd,
        model,
        rolePrompt: nodeRolePrompt(id, run.workflow, cwd),
        tools: spec.tools ?? DEFAULT_TOOLS,
        skills: nodeSkills,
        ...(spec.verdict === undefined ? {} : { verdictSchema: spec.verdict }),
        onComplete(done) {
          completion = { summary: done.summary, ...(done.verdict === undefined ? {} : { verdict: done.verdict }) }
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

      const interruptForPause = (): void => {
        if (session.isStreaming()) void session.abort().catch(() => {})
      }
      handle.pauseInterrupts.add(interruptForPause)

      // One session can back several node records (the original plus its
      // revisions); each record reports its own delta of the session totals.
      let statBase = { toolCalls: 0, cost: 0 }
      let sessionStats = { toolCalls: 0, cost: 0 }

      // The first observation, never the last write: a stamp is set once and
      // never removed, so a file deleted after the fact does not un-write it.
      const stampWritten = (): void => {
        for (const [at, artifact] of node.artifacts.entries()) {
          if (artifact.writtenAt !== undefined) continue
          if (onDisk(artifact.path)) node.artifacts[at] = { ...artifact, writtenAt: nowIso() }
        }
      }

      const captureStats = (): void => {
        stampWritten()
        const stats = session.stats()
        sessionStats = { toolCalls: stats.toolCalls, cost: stats.cost ?? 0 }
        node.toolCalls = Math.max(0, sessionStats.toolCalls - statBase.toolCalls)
        if (stats.cost !== undefined) {
          node.cost = round4(carried.cost + Math.max(0, stats.cost - statBase.cost))
        }
        if (stats.contextPercent !== undefined) node.contextPercent = stats.contextPercent
        store.writeTranscript(run.id, node.id, session.transcript())
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
        const revisionId = nextRevisionId(id)
        const revisionParents = [
          ...new Set([node.id, ...keptParents(run, revisionId, from ?? [])])
        ]
        captureStats()
        statBase = { ...sessionStats }
        // A revision is its own record from zero: what the record it follows
        // burned stays on that record.
        carried = { cost: 0, cacheMisses: 0 }
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
      let watchdogAborted = false
      const watchdog = setInterval(() => {
        if (!session.isStreaming()) return
        const lastActivity = node.lastActivityAt ?? node.startedAt
        const quiet = Date.now() - (lastActivity === undefined ? Date.now() : Date.parse(lastActivity))
        if (quiet > quietAbortMs) {
          watchdogAborted = true
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
        delete node.now
        if (node.endedAt === undefined || node.status !== status) node.endedAt = nowIso()
        node.status = status
        if (error !== undefined) node.error = error
        offActivity()
        clearInterval(watchdog)
        if (snapshotTimer !== undefined) clearTimeout(snapshotTimer)
        captureStats()
        session.dispose()
        save(run)
      }

      // Runner-owned release: the workflow is expected to close() a held-open
      // node but cannot be trusted to — the engine backstops the session.
      let releasing = false
      const control = {
        async release(): Promise<void> {
          if (finished) return
          releasing = true
          if (parked) {
            parkResolve?.({ type: 'close' })
            return
          }
          await session.abort().catch(() => {})
        },
        forceDispose(): void {
          finishNode('failed', 'the run ended before this node finished')
        }
      }
      handle.live.add(control)

      const bailIfReleased = (): void => {
        if (!releasing) return
        finishNode('failed', 'the run ended before this node finished')
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

      const validate = (): string[] => {
        const problems: string[] = []
        for (const [name, path] of Object.entries(outputPaths)) {
          if (!existsSync(path) || statSync(path).size === 0) {
            problems.push(`required output "${name}" is missing or empty: ${path}`)
          }
        }
        stampWritten()
        if (spec.check !== undefined) {
          try {
            problems.push(...spec.check(outputPaths))
          } catch (cause) {
            problems.push(
              `deterministic check threw: ${cause instanceof Error ? cause.message : String(cause)}`
            )
          }
        }
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
            }
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
            const problems = validate()
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
              if (directive.type === 'close' || releasing) {
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

          // Pause parks the node between turns; the interrupter aborted any
          // in-flight turn. Completed or blocked work above is honored first.
          if (pauseAsked() && !releasing) {
            watchdogAborted = false
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

          if (watchdogAborted) {
            watchdogAborted = false
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

    /** A workflow-level question. The run stays `running` while parked. */
    async function ask(question: {
      reason: string
      artifacts?: Record<string, string>
    }): Promise<string> {
      if (cancelAsked()) throw new Error('the run was cancelled')
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
      save(run)
      return answer
    }

    const ctx: RunContext = {
      inputs: run.inputs,
      artifactDir: artifacts,
      cwd,
      node: (id, spec) => track(runNode(id, spec)),
      openNode: (id, spec) =>
        new Promise<OpenNode>((resolve, reject) => {
          track(runNode(id, spec, resolve)).catch(reject)
        }),
      ask,
      derive: (path, fromNodeId) => {
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
      const outputs = await def.run(ctx)
      outcome = 'complete'
      if (outputs !== undefined && outputs !== null) run.outputs = outputs
    } catch (cause) {
      outcome = handle.cancelRequested ? 'cancelled' : 'failed'
      if (!handle.cancelRequested) {
        run.error = cause instanceof Error ? cause.message : String(cause)
      }
    }

    await releaseLiveNodes(handle)
    rejectWaiters(handle, 'the run ended')
    if (outcome === 'complete') {
      // Ghosts that never materialized were branches not taken.
      run.nodes = run.nodes.filter((node) => node.status !== 'pending')
    }

    // However the run ended, its work survives as a commit on its own branch
    // — unless the workflow said it commits for itself. Never merged, never
    // pushed: bringing the work back is the orchestrator's judgment.
    let committed = false
    if (def.commit !== false && run.worktreePath !== undefined) {
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
  async function releaseLiveNodes(handle: Handle): Promise<void> {
    if (handle.live.size === 0) return
    await Promise.allSettled([...handle.live].map((control) => control.release()))
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
    for (const control of [...handle.live]) control.forceDispose()
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
   * Total over the two stopped states. A paused run un-pauses. An interrupted
   * one re-runs the node the quit cut down, from that node's beginning, in the
   * same worktree, reporting to the same orchestrator; everything the previous
   * life completed is replayed from the record at no cost. Every other status
   * is refused, and so is a missing worktree or a workflow that no longer
   * resolves — all before anything can cost money.
   */
  async function resumeRun(runId: WorkflowRunId): Promise<void> {
    const run = requireRecord(runId)
    if (run.status === 'paused') {
      const handle = handles.get(runId)
      if (handle === undefined) throw new Error(`The run "${runId}" is not live.`)
      if (handle.desired !== 'paused') return
      handle.desired = 'running'
      handle.run.status = 'running'
      save(handle.run)
      return
    }
    if (run.status !== 'interrupted') throw new Error(resumeRefusal(runId, run.status))
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
            `(${run.worktreePath ?? 'none was recorded'}). Resume re-runs the interrupted node ` +
            'in the same worktree and never makes a new one.'
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
      for (const node of run.nodes) {
        if (node.status === 'interrupted') revertToGhost(node)
      }

      const handle: Handle = {
        run,
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
      log?.({ event: 'run_resumed', runId, workflow: run.workflow, branch: run.branch })

      void execute(handle, resolved.def, true).catch((cause: unknown) => {
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
    void releaseLiveNodes(handle)
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

    resume: resumeRun,

    cancel: cancelRun,

    wake(sessionId: SessionId): void {
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

    nodeTranscript(runId: WorkflowRunId, nodeId: string): readonly TranscriptItem[] {
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
        void releaseLiveNodes(handle)
      }
    }
  }
}

// The last moment any node of this run was seen doing something, which is the
// most honest stop time a swept record can be given. Absent when no node ever
// recorded activity at all.
function latestNodeStop(run: LiveRun): string | undefined {
  const stamps = run.nodes
    .flatMap((node) => [node.lastActivityAt, node.endedAt])
    .filter((at): at is string => at !== undefined)
  if (stamps.length === 0) return undefined
  return stamps.reduce((latest, at) => (Date.parse(at) > Date.parse(latest) ? at : latest))
}

// An interrupted node back to the pending ghost the plan first drew: same id,
// same parents, its declared artifacts unwritten. What it already spent stays
// on the record — the money was really spent, and the re-run adds to it — and
// everything the dead session said about itself goes.
function revertToGhost(node: LiveNode): void {
  node.status = 'pending'
  node.artifacts = node.artifacts.map(({ name, path, desc }) => ({ name, path, desc }))
  delete node.error
  delete node.summary
  delete node.verdict
  delete node.startedAt
  delete node.endedAt
  delete node.lastActivityAt
  delete node.now
  delete node.toolCalls
  delete node.contextPercent
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

function nodeRolePrompt(nodeId: string, workflow: string, cwd: string): string {
  return [
    `You are "${nodeId}", one worker node in the Crucible workflow "${workflow}".`,
    `Working directory: ${cwd}`,
    '',
    'You have no interactive user. Work autonomously. Contract:',
    '- Your task lists required input files; read the ones you need before acting.',
    '- You must produce every declared output file with real, complete content.',
    '- You are NOT done until you call the complete_node tool. Ending a message is not completion.',
    '- If the environment is broken, inputs are malformed or incomplete, or anything abnormal prevents doing the task properly, call raise_blocker. Do not improvise around problems and do not ask questions in plain text — nobody is reading it.',
    '- After raise_blocker, stop and wait; a response will arrive as your next message.',
    '- Never fabricate results. Verify claims by running tools.'
  ].join('\n')
}

function composeTaskPrompt(spec: NodeSpec, outputs: Record<string, string>): string {
  const parts: string[] = [spec.prompt]
  if (spec.reads !== undefined && spec.reads.length > 0) {
    parts.push('', 'Input files (read what you need):', ...spec.reads.map((path) => `- ${path}`))
  }
  const outputEntries = Object.entries(spec.outputs ?? {})
  if (outputEntries.length > 0) {
    parts.push(
      '',
      'Required output files (create each one; the run validates them):',
      ...outputEntries.map(([name, output]) => `- ${outputs[name]} — ${name}: ${output.desc}`)
    )
  }
  if (spec.verdict !== undefined) {
    parts.push(
      '',
      'When you call complete_node, you must include a `verdict` argument matching this JSON schema:',
      JSON.stringify(spec.verdict, null, 2)
    )
  }
  parts.push('', 'When everything above is genuinely done, call complete_node.')
  return parts.join('\n')
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
