import type { SessionId } from './port'
import type { ResumeKind } from '../workflows/run'

// Both adapters build their run tools from these definitions, so the five
// tools cannot drift into meaning different things in the two flavors. The
// descriptions carry the orchestration teaching too: a description rides the
// request's tools parameter, the one channel Crucible's system prompt does
// not replace.

export type RunToolName =
  | 'crucible_workflows'
  | 'crucible_run'
  | 'crucible_runs'
  | 'crucible_answer'
  | 'crucible_resume'

export interface RunToolParameter {
  readonly name: string
  readonly description: string
  /** Absent means required. */
  readonly optional?: boolean
  /** Schema shape; absent means string. `map` is an object of string values. */
  readonly kind?: 'map'
}

export interface RunToolDefinition {
  readonly name: RunToolName
  /** Human-readable, for a tool row. */
  readonly label: string
  readonly description: string
  readonly parameters: readonly RunToolParameter[]
}

export const RUN_TOOLS: readonly RunToolDefinition[] = [
  {
    name: 'crucible_workflows',
    label: 'List Workflows',
    description:
      'List the Crucible workflows this workspace can run: name, description, the inputs each expects, and ' +
      'the target repository a workflow fixes or requires. A workflow is a TypeScript definition of ' +
      'automated agent work; running one starts a run — a team of fresh agents working in a worktree of ' +
      'its own. Call this before crucible_run when you are not sure of a name, its inputs or its target.',
    parameters: []
  },
  {
    name: 'crucible_run',
    label: 'Start Workflow Run',
    description:
      'Start a run of a named workflow. The run works in its own git worktree, branched from a commit — ' +
      'never from the working tree — so uncommitted work here is invisible to it; commit first if the run ' +
      'must see it. By default the run branches from the HEAD of your working directory; pass `base` to ' +
      'branch from another commit-ish (for example the trunk).\n\n' +
      'A run has exactly one target repository: the one its worktree is of, where every node works, where ' +
      'its work is committed and whose branch its completion names. By default that is this workspace\'s ' +
      'own repository. When the change belongs in a git repository cloned inside the workspace folder, ' +
      'pass `target` with its path relative to that folder (for example "ifs-enr-core-acct-app"); the run ' +
      'then branches from that repository\'s HEAD, or from `base` resolved there, and nothing of it happens ' +
      'in the workspace\'s repository. A workflow may fix its target (then name that one or none) or ' +
      'require one (then you must name it); crucible_workflows says which. A target that is not the top ' +
      'of a git repository inside the workspace folder, or that disagrees with the workflow, is refused ' +
      'before anything is spent.\n\n' +
      'Inputs are file paths: write the input file first (a prompt, an intent document), then pass its ' +
      'path. The run works unattended and reports back to this session — check-ins, blockers, errors and ' +
      'completion all arrive here as messages. Kicking off a run and ending your turn is a normal, quiet ' +
      'state: do not wait or poll. When the run finishes it names its worktree and branch; you then judge ' +
      'when to pull the work in and how to resolve conflicts.\n\n' +
      'For the full contract — chains, verdicts, writing new workflows — read the workflows page of the ' +
      'agent docs.',
    parameters: [
      { name: 'workflow', description: 'Workflow name, as crucible_workflows lists it' },
      {
        name: 'inputs',
        description:
          'Object mapping input name to absolute file path, e.g. {"prompt": "/tmp/task.md"}. ' +
          'Omit for a workflow with no inputs.',
        optional: true,
        kind: 'map'
      },
      {
        name: 'base',
        description:
          'Commit-ish the run branches from, resolved in the run\'s target repository. Defaults to HEAD of ' +
          'your working directory, or of the target repository when you name one.',
        optional: true
      },
      {
        name: 'target',
        description:
          'The run\'s target repository: a git repository inside the workspace folder, as a path relative ' +
          'to that folder, e.g. "ifs-enr-core-acct-app". Omit for the workspace\'s own repository.',
        optional: true
      }
    ]
  },
  {
    name: 'crucible_runs',
    label: 'List Runs',
    description:
      "List this session's workflow runs and where each stands: current node, status, spend, and any " +
      'question waiting on you. Read it when the user asks how a run is doing; never poll it while ' +
      'nothing is waiting.',
    parameters: []
  },
  {
    name: 'crucible_answer',
    label: 'Answer Run',
    description:
      'Answer the question a run has raised — a check-in or a blocker that arrived here as a message. ' +
      'Answer from your own context when you can; bring it to the user first when it needs their ' +
      'judgment. The text reaches the waiting agent verbatim and the run resumes.',
    parameters: [
      { name: 'runId', description: 'The run whose question is being answered' },
      { name: 'message', description: 'The answer, delivered verbatim to the waiting agent' }
    ]
  },
  {
    name: 'crucible_resume',
    label: 'Resume Run',
    description:
      'Put a stopped run back to work — interrupted by a quit, failed, cancelled or paused. ' +
      'Whatever stopped it, its worktree and artifacts are intact and nothing about it moves ' +
      'again until somebody deliberately resumes it.\n\n' +
      'Resuming continues the node it stopped on from that node’s last turn, in its own ' +
      'session and the same worktree, reporting to this session as before. Nothing already ' +
      'burned is spent twice: completed nodes, answered check-ins and recorded results are ' +
      'handed back from the record.\n\n' +
      'Resume when the user asks, or when this conversation’s own judgment says the work is ' +
      'still wanted. Never as a reflex to seeing an interruption message: the run sits at no ' +
      'cost, so bring it to the user whenever the spend is theirs to weigh.',
    parameters: [
      { name: 'runId', description: 'The stopped run to resume' },
      {
        name: 'how',
        description:
          '"continue" (the default) carries the stopped node on from its last turn. ' +
          '"clean-restart" runs it again from its prompt with no memory of the attempt that ' +
          'stopped — for a node that died in a loop, where continuing would resume the loop. ' +
          'The earlier transcript stays readable either way.',
        optional: true
      }
    ]
  }
]

// Where a run starts from, both halves optional: the commit-ish it branches
// from and the target repository it works in, as the tool call named them.
export interface RunKickoff {
  readonly base?: string
  readonly target?: string
}

export function runTool(name: RunToolName): RunToolDefinition {
  const found = RUN_TOOLS.find((tool) => tool.name === name)
  if (found === undefined) throw new Error(`${name} is not a workflow run tool.`)
  return found
}

// An adapter is handed behaviors rather than engine state. Every method
// resolves with exactly the text the tool result must show; a failure throws,
// carrying the sentence the model should read.
export interface RunTools {
  workflows(workingDir: string): Promise<string>
  // `workingDir` is the directory the calling session works in — its worktree
  // or its checkout — which is where the default base commit is read.
  start(
    sessionId: SessionId,
    workingDir: string,
    workflow: string,
    inputs: Readonly<Record<string, string>>,
    kickoff?: RunKickoff
  ): Promise<string>
  list(sessionId: SessionId): Promise<string>
  answer(sessionId: SessionId, runId: string, message: string): Promise<string>
  // No session check, exactly as `answer` has none: the deliberate call is the
  // authorization, and the run goes on reporting to its recorded orchestrator.
  resume(sessionId: SessionId, runId: string, kind?: ResumeKind): Promise<string>
}
