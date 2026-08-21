import type { SessionId } from './port'

// Both adapters build their run tools from these definitions, so the four
// tools cannot drift into meaning different things in the two flavors. The
// descriptions carry the orchestration teaching too: a description rides the
// request's tools parameter, the one channel Crucible's system prompt does
// not replace (ADR 0012).

export type RunToolName =
  | 'crucible_workflows'
  | 'crucible_run'
  | 'crucible_runs'
  | 'crucible_answer'

export interface RunToolParameter {
  readonly name: string
  readonly description: string
  /** Absent means required. */
  readonly optional?: boolean
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
      'List the Crucible workflows this workspace can run: name, description and the inputs each expects. ' +
      'A workflow is a TypeScript definition of automated agent work; running one starts a run — a team of ' +
      'fresh agents working in a worktree of its own. Call this before crucible_run when you are not sure ' +
      'of a name or its inputs.',
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
          'JSON object mapping input name to absolute file path, e.g. {"prompt": "/tmp/task.md"}. ' +
          'Omit for a workflow with no inputs.',
        optional: true
      },
      {
        name: 'base',
        description:
          'Commit-ish the run branches from. Defaults to HEAD of your working directory.',
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
  }
]

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
    base?: string
  ): Promise<string>
  list(sessionId: SessionId): Promise<string>
  answer(sessionId: SessionId, runId: string, message: string): Promise<string>
}
