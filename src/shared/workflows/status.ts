import type { SessionId } from '../agent/port'
import {
  currentNode,
  cutRevisions,
  INTERRUPTED_MESSAGE,
  resumePlan,
  runCost,
  runMessageHeader,
  stoppedNodes,
  type ResumeKind,
  type RunNode,
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
    // A branch reads ambiguously once runs span repositories, so a run outside
    // the workspace's own names the one its branch is in.
    run.targetRepository === undefined ? undefined : `repository ${run.targetRepository}`,
    run.branch,
    run.waiting === true && run.question !== undefined
      ? `⚑ waiting on an answer: ${run.question.reason.split('\n')[0]}`
      : undefined,
    // The state and the lever in one line, so a listing agent needs nothing
    // else to act on a run that stopped short of finishing.
    run.status === 'interrupted' || run.status === 'failed' || run.status === 'cancelled'
      ? 'resume with crucible_resume if this work is still wanted'
      : undefined
  ]
  return `- ${parts.filter((part): part is string => part !== undefined).join(' · ')}`
}

/** `interrupted` never appears without why it stopped. */
function statusPhrase(run: RunRecord): string {
  return run.status === 'interrupted' ? 'interrupted · app quit' : run.status
}

/** The nodes a resume puts back to work, as a fragment naming them. */
function namedNodes(nodes: readonly RunNode[]): string {
  const named = nodes.map((node) => `"${node.id}"`)
  if (named.length === 0) return 'the node it stopped at'
  if (named.length === 1) return `node ${named[0]}`
  return `nodes ${named.join(', ')}`
}

/**
 * What resuming this run would do, as one sentence about its nodes, worded
 * from the split `resumePlan` makes: continued nodes carry on from their last
 * turn, restarted ones run again from their prompt. One node is named once
 * however many records its chain holds, because the engine performs one act
 * on it. When the plan is empty the sentence reads the chains too rather than
 * falling back to fixed words, because an empty plan is not an unknown state:
 * it is a run the quit caught between nodes, or on a workflow-level check-in,
 * or mid-revision of a node whose own record completed. The engine replays
 * what completed in every one of them. What it then does to a cut revision is
 * the same two-way split, read from the same token the engine reopens, so a
 * record written before sessions outlived the app is told it runs again from
 * its prompt rather than promised a continuation nothing can make.
 */
function resumeSentence(run: RunRecord, kind: ResumeKind): string {
  const { continued, restarted } = resumePlan(run, kind)
  const where = run.worktreePath === undefined ? '' : ` (${run.worktreePath})`
  const parts: string[] = []
  if (continued.length === 0 && restarted.length === 0) {
    parts.push(
      `the run picks up where it stopped, in the same worktree${where}, handing back what it ` +
        'already finished from the record rather than working it again'
    )
    const cut = cutRevisions(run)
    if (cut.continued.length > 0) {
      const one = cut.continued.length === 1
      parts.push(
        `${namedNodes(cut.continued)} ${one ? 'is a revision' : 'are revisions'} the quit cut ` +
          `down, and ${one ? 'it continues' : 'they continue'} in the session ` +
          `${one ? 'that node was' : 'those nodes were'} working in, so nothing ` +
          `${one ? 'it' : 'they'} already spent is spent again`
      )
    }
    if (cut.restarted.length > 0) {
      const one = cut.restarted.length === 1
      parts.push(
        `${namedNodes(cut.restarted)} ${one ? 'is a revision' : 'are revisions'} the quit cut ` +
          `down with no session left to continue, so ${one ? 'it runs' : 'they run'} again from ` +
          `${one ? 'its' : 'their'} prompt as a fresh attempt beside the ` +
          `${one ? 'one' : 'ones'} that stopped`
      )
    }
    return `Resuming: ${parts.join('; ')}.`
  }
  if (continued.length > 0) {
    const one = continued.length === 1
    parts.push(
      `${namedNodes(continued)} ${one ? 'continues' : 'continue'} from ${one ? 'its' : 'their'} ` +
        `last turn, in the same session and the same worktree${where}, so nothing ` +
        `${one ? 'it' : 'they'} already spent is spent again`
    )
  }
  if (restarted.length > 0) {
    const one = restarted.length === 1
    parts.push(
      kind === 'clean-restart'
        ? `${namedNodes(restarted)} ${one ? 'runs' : 'run'} again from ${one ? 'its' : 'their'} ` +
          `prompt, in the same worktree${where}, as a fresh attempt beside the one that stopped`
        : `${namedNodes(restarted)} ${one ? 'has' : 'have'} no session left to continue, so ` +
          `${one ? 'it runs' : 'they run'} again from ${one ? 'its' : 'their'} prompt as a ` +
          'fresh attempt beside the one that stopped'
    )
  }
  return `Resuming: ${parts.join('; ')}.`
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
      `${resumeSentence(run, 'continue')} It reports back here as usual.`,
      '',
      `Resume it with the crucible_resume tool (runId "${run.id}") when the work is still ` +
        'wanted; nothing resumes on its own. Judge that from this conversation, and bring it ' +
        'to the user when it needs their judgment.'
    ].join('\n')
  }
  if (run.status === 'running' || run.status === 'paused') {
    const working = run.nodes.filter((node) => node.status === 'running')
    return [
      `${header} was interrupted by an app quit and has since been resumed.`,
      '',
      `It is working on ${namedNodes(working)} in the same worktree, and reports back here as ` +
        'it did before.'
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

/**
 * What `crucible_resume` answers with, in both flavors. `before` is the
 * record as it stood when the resume was asked for: once it is working, what
 * it stopped on is no longer readable from it.
 */
export function resumeAnswer(
  run: RunRecord,
  before: RunRecord | undefined,
  kind: ResumeKind = 'continue'
): string {
  const what =
    before === undefined || stoppedNodes(before).length === 0
      ? `Run ${run.id} of "${run.workflow}" is working again.`
      : `Run ${run.id} of "${run.workflow}" is resuming. ${resumeSentence(before, kind)}`
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
