import type { SessionId } from '../agent/port'
import {
  currentNode,
  INTERRUPTED_MESSAGE,
  interruptedNodes,
  runCost,
  runMessageHeader,
  type RunRecord,
  type WorkflowRunId
} from './run'

// What an agent is told about the state of its runs, in one module so the two
// flavors cannot say it two ways: the line `crucible_runs` lists, the notice a
// run owes its orchestrator after Crucible quit under it, what `crucible_resume`
// answers with, and the turn-start hook that keeps a session's picture fresh.
//
// Nothing here holds a record or reaches a store. The engine stays the only
// writer of `noticePending` and the only thing that speaks for a run; it calls
// these at the moment it delivers, so no stored sentence can outlive the world
// it described.

/** One run, as `crucible_runs` lists it and as a turn-start injection names it. */
export function describeRun(run: RunRecord): string {
  const node = currentNode(run)
  const cost = runCost(run)
  const parts = [
    `run ${run.id} (${run.workflow}) — ${statusPhrase(run)}`,
    node === undefined ? undefined : `node ${node.id} ${node.status}`,
    cost === undefined ? undefined : `$${cost.toFixed(2)}`,
    run.branch,
    run.waiting === true && run.question !== undefined
      ? `⚑ waiting on an answer: ${run.question.reason.split('\n')[0]}`
      : undefined,
    // The state and the lever in one line, so a listing agent needs nothing
    // else to act on an interrupted run.
    run.status === 'interrupted'
      ? 'resume with crucible_resume if this work is still wanted'
      : undefined
  ]
  return `- ${parts.filter((part): part is string => part !== undefined).join(' · ')}`
}

/** `interrupted` never appears without why it stopped. */
function statusPhrase(run: RunRecord): string {
  return run.status === 'interrupted' ? 'interrupted · app quit' : run.status
}

// The nodes Resume re-runs, as a sentence fragment naming them: the ones the
// quit cut down, or — once the run has been resumed and they are ghosts again
// — whatever is working now.
function cutNodes(run: RunRecord): string {
  const cut = interruptedNodes(run)
  const named = (cut.length > 0 ? cut : run.nodes.filter((node) => node.status === 'running')).map(
    (node) => `"${node.id}"`
  )
  if (named.length === 0) return 'the node it stopped at'
  if (named.length === 1) return `node ${named[0]}`
  return `nodes ${named.join(', ')}`
}

/**
 * The message a run owes its orchestrator after an app quit, composed from the
 * record at the moment of delivery: a run that has been resumed in the
 * meantime says so instead, and a settled one states where it landed. Nothing
 * about it is stored, so it cannot describe a world that has moved on.
 */
export function interruptionNotice(run: RunRecord): string {
  const header = runMessageHeader(run)
  if (run.status === 'interrupted') {
    return [
      `${header} was interrupted.`,
      '',
      INTERRUPTED_MESSAGE,
      '',
      `Resuming re-runs ${cutNodes(run)} from its beginning, in the same worktree` +
        `${run.worktreePath === undefined ? '' : ` (${run.worktreePath})`}, reporting back ` +
        'here as usual. That re-spends what the node had already burned.',
      '',
      `Resume it with the crucible_resume tool (runId "${run.id}") when the work is still ` +
        'wanted; nothing resumes on its own. Judge that from this conversation, and bring it ' +
        'to the user when it needs their judgment.'
    ].join('\n')
  }
  if (run.status === 'running' || run.status === 'paused') {
    return [
      `${header} was interrupted by an app quit and has since been resumed.`,
      '',
      `It is re-running ${cutNodes(run)} from its beginning, in the same worktree, and reports ` +
        'back here as it did before.'
    ].join('\n')
  }
  // Unreachable in practice: whatever settled the run said so through this
  // same channel, and that cleared the debt. A record found this way is stated
  // plainly rather than dressed up.
  return [
    `${header} was interrupted by an app quit; it is ${run.status} now.`,
    ...(run.error === undefined ? [] : ['', run.error])
  ].join('\n')
}

/** What `crucible_resume` answers with, in both flavors. */
export function resumeAnswer(run: RunRecord, cut: readonly string[]): string {
  const where = run.worktreePath === undefined ? '' : ` in ${run.worktreePath}`
  const what =
    cut.length === 0
      ? `Run ${run.id} of "${run.workflow}" is working again.`
      : `Run ${run.id} of "${run.workflow}" is resuming: ${cut.map((id) => `"${id}"`).join(', ')} ` +
        `${cut.length === 1 ? 're-runs' : 're-run'} from the beginning${where}.`
  return (
    `${what}\nIt reports back here as messages — check-ins, blockers and completion — as it ` +
    'did before. Ending your turn now is the normal thing to do.'
  )
}

/** Opens the injected block, so no model reads it as the user speaking. */
const PREAMBLE =
  'Crucible status update — automatic, and not sent by the user. Runs of this session whose ' +
  'state changed since the last update:'

export interface TurnStartOptions {
  /** Every record the service knows; filtered to the session here. */
  readonly runs: () => readonly RunRecord[]
  // Delivers whatever this session is owed about its runs — an interruption
  // notice — before the block is built, so the block reads the records as
  // they stand once that has happened. Not "wake": that word names a
  // monitor's message, and nothing here is one.
  readonly deliverNotices: (sessionId: SessionId) => void
}

/**
 * The turn-start hook: called once at the start of every user turn of a
 * session, it wakes that session's pending run notices and answers with the
 * status block the model must see, or nothing at all.
 *
 * The fingerprints are in-memory by design: a fresh launch knows nothing, so
 * the first turn after a restart injects everything, which is the honesty this
 * exists for. They are recorded here, one line before the prompt is dispatched,
 * so a turn that never went out cannot mark a change as told.
 */
export function createTurnStart({
  runs,
  deliverNotices
}: TurnStartOptions): (sessionId: SessionId) => string | undefined {
  const injected = new Map<SessionId, Map<WorkflowRunId, string>>()

  return (sessionId: SessionId): string | undefined => {
    deliverNotices(sessionId)
    const mine = runs().filter((run) => run.sessionId === sessionId)
    // A session that orchestrates nothing is never injected into, whatever it
    // has heard before.
    if (mine.length === 0) return undefined
    const told = injected.get(sessionId) ?? new Map<WorkflowRunId, string>()
    injected.set(sessionId, told)

    const lines: string[] = []
    for (const run of mine) {
      const print = fingerprint(run)
      if (told.get(run.id) === print) continue
      told.set(run.id, print)
      lines.push(describeRun(run))
    }
    if (lines.length === 0) return undefined
    return [PREAMBLE, ...lines].join('\n')
  }
}

// What "changed" means: where the run stands, which node it is at and what
// that node is doing, and whether anybody owes it an answer. Money moving is
// not a change worth a turn's tokens.
function fingerprint(run: RunRecord): string {
  const node = currentNode(run)
  return [
    run.status,
    node?.id ?? '',
    node?.status ?? '',
    run.waiting === true ? 'waiting' : ''
  ].join('|')
}
