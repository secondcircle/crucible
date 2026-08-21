import { runCost, type RunRecord } from '../../../shared/workflows/run'

// What Investigate sends: the whole of what the record knows, because the
// app starts the investigation rather than telling the user where to look.
// Built from the `RunRecord` alone — the renderer never guesses at storage
// layout — with a fact the record lacks omitted whole rather than printed
// blank. It is ordinary user text: it must never open with the run-message
// prefix, which marks a run talking to its orchestrator.

export function investigationPrompt(run: RunRecord): string {
  const lines: string[] = [
    `Investigate Crucible run ${run.id}, a run of the "${run.workflow}" workflow.`,
    '',
    ...facts(run),
    ...failure(run),
    ...parked(run),
    ...whereItLives(run),
    '',
    'This run now reports to this session: it has been made the run\u2019s orchestrator, so its ' +
      'future check-ins, blockers and completion arrive here as messages, and crucible_runs ' +
      'lists it for you.',
    '',
    'Work out what actually happened, then open your reply with the run\u2019s status readout \u2014 ' +
      'the state of the run in a few lines \u2014 so that is the first thing read. Take follow-up ' +
      'questions from there.'
  ]
  return lines.join('\n')
}

/** The identity block: what the run is, where it worked, what it cost. */
function facts(run: RunRecord): readonly string[] {
  const spend = runCost(run)
  return [
    `- status: ${run.status}${run.dismissedAt === undefined ? '' : ' (dismissed by the user)'}`,
    ...maybe('branch', run.branch),
    ...maybe('base commit', run.baseCommit?.slice(0, 7)),
    ...maybe('worktree', run.worktreePath),
    ...maybe('spend', spend === undefined ? undefined : `$${spend.toFixed(2)}`)
  ]
}

/** Whatever the record says went wrong, node-level first. */
function failure(run: RunRecord): readonly string[] {
  const failed = run.nodes.filter((node) => node.status === 'failed')
  const nodeLines = failed.map(
    (node) => `- failing node "${node.id}": ${node.error ?? 'no error was recorded'}`
  )
  return [...nodeLines, ...maybe('run error', run.error)]
}

// A run parked on a question is the case this feature exists to unstick, so
// the answer is spelled out as an instruction rather than left to be worked
// out from the tool description.
function parked(run: RunRecord): readonly string[] {
  if (run.waiting !== true || run.question === undefined) return []
  return [
    '',
    `This run is waiting on an answer: ${run.question.reason}`,
    `Answer it with the crucible_answer tool (runId "${run.id}"); the run resumes from there.`
  ]
}

function whereItLives(run: RunRecord): readonly string[] {
  if (run.dir === undefined) return []
  return [
    '',
    `Everything this run wrote is under ${run.dir}: \`run.json\` (the record itself), ` +
      '`artifacts/` (what its nodes produced) and `transcripts/<node>.json` (what each node ' +
      'did, turn by turn). Read them before concluding anything.'
  ]
}

/** One bullet, or nothing at all where the record carries no such fact. */
function maybe(label: string, value: string | undefined): readonly string[] {
  return value === undefined || value === '' ? [] : [`- ${label}: ${value}`]
}
