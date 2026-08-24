/**
 * The Crucible authoring API: what a workflow file writes against.
 *
 * A workflow is a TypeScript definition of automated agent work; what
 * executes is a run. Nodes are fresh-context agent sessions with pushed
 * inputs (file paths) and declared output artifacts, validated on
 * completion. Kept from the legacy system essentially as-is, venue concepts
 * excepted: every run works in a worktree of its own, branched from a
 * commit, so nothing here chooses where a run happens.
 *
 * Workflow files import this surface as `crucible:workflow`; the loader
 * aliases that to the shipped copy of this module, so a workflow in any
 * repository resolves it without a node_modules of its own.
 */

/**
 * A JSON Schema object (the subset verdict validation understands: type,
 * properties, required, enum, const, items). Plain data, so a workflow file
 * needs no schema library.
 */
export type VerdictSchema = Record<string, unknown>

export interface OutputSpec {
  /** File name, created under the run's artifact directory. */
  file: string
  /** One-line description shown in the graph and given to consumers. */
  desc: string
}

export interface NodeSpec {
  /** The node's task. Keep it locally scoped: no references to other nodes. */
  prompt: string
  /**
   * Ids of the nodes this node follows — declared here because nodes born
   * inside a runtime loop can never appear in plan(). Ids naming no node in
   * the run are ignored; artifact dataflow adds edges, never removes one.
   */
  from?: string[]
  /** Absolute paths of required input files. Preflight fails if any is missing. */
  reads?: string[]
  /** Declared output artifacts; the node is not complete until they validate. */
  outputs?: Record<string, OutputSpec>
  /**
   * Machine-readable conclusion the workflow code branches on. The agent must
   * supply a matching `verdict` in its complete_node call.
   */
  verdict?: VerdictSchema
  /** "provider/model-id:thinkingLevel", e.g. "anthropic/claude-opus-5:high". */
  model?: string
  /** Built-in tool names. Defaults to read/bash/edit/write/grep/find/ls. */
  tools?: string[]
  /**
   * Deterministic output validation (lint). Runs alongside the built-in
   * checks on every complete_node; returned problems are delivered back into
   * the SAME agent session as a rejection, so fixes happen with full context.
   */
  check?(outputs: Record<string, string>): string[]
}

export interface ReviseOptions {
  /**
   * Ids of the nodes whose findings triggered this revision (the reviewers).
   * They become parents of the revision node alongside the current tip, so
   * the graph shows what was sent back and by whom. Ids that name no node in
   * the run are ignored — a parent never points at nothing.
   */
  from?: string[]
}

export interface NodeResult {
  /** Output name -> absolute artifact path. */
  outputs: Record<string, string>
  /** Validated verdict, when the node declared a schema. */
  verdict: unknown
  /** The agent's completion summary. */
  summary: string
}

/**
 * A completed node whose session is intentionally kept alive, so later
 * feedback (audit findings, review verdicts) can be sent back into the same
 * context instead of a cold new agent. Callers MUST eventually close().
 */
export interface OpenNode {
  /** The first validated result. Later revisions resolve from revise(). */
  result: NodeResult
  /**
   * Id of the node record currently carrying this session: the original id,
   * then `<id>·r1`, `<id>·r2`, … as revisions unroll.
   */
  readonly id: string
  /**
   * Deliver feedback into the same session; resolves with the next validated
   * completion. Each call appends a NEW node (`<id>·r<n>`) to the run graph —
   * same session, new record — chained after the current tip and after the
   * reviewer nodes named in `opts.from`.
   */
  revise(message: string, opts?: ReviseOptions): Promise<NodeResult>
  /** Release the session; the node stays complete with its latest result. */
  close(): void
}

/**
 * What a workflow says when it schedules a successor: a workflow name and its
 * inputs. The engine starts the successor directly when THIS run completes
 * cleanly, in a fresh worktree continuing this run's branch from its final
 * commit. The name resolves at stage time through the origin
 * ladder — workspace over user over built-in — so a wrapper at an outer
 * origin can name a workflow further in.
 */
export interface StageOptions {
  /** Workflow to stage. Unknown names fail this run's stage call. */
  workflow: string
  /**
   * Input name -> absolute path. Artifacts THIS run has not written yet are
   * legal: a staged successor's inputs are checked when it starts.
   */
  inputs: Record<string, string>
}

export interface RunContext {
  /** Input name -> absolute file path, validated before the run started. */
  inputs: Record<string, string>
  /** Absolute path of this run's artifact directory (outside the repo). */
  artifactDir: string
  /** The run's own worktree: where every node works. */
  cwd: string
  /** Execute one agent node; resolves when the node completes. */
  node(id: string, spec: NodeSpec): Promise<NodeResult>
  /** Like node(), but holds the session open for revise() feedback loops. */
  openNode(id: string, spec: NodeSpec): Promise<OpenNode>
  /**
   * Ask the orchestrator. `reason` reaches its agent verbatim, so it is
   * prompt text; the answer comes back verbatim too. The run parks with no
   * timeout and stays `running`: `paused` is what a human did to a run.
   */
  ask(question: { reason: string; artifacts?: Record<string, string> }): Promise<string>
  /**
   * Register a file the WORKFLOW wrote (a split, a merge, an extract) as
   * produced by `fromNodeId`, so nodes reading it infer a real parent instead
   * of hanging parentless in the graph. Throws if the node does not exist.
   */
  derive(path: string, fromNodeId: string): void
  /**
   * Stage a successor run and return its id. Not idempotent — two calls
   * stage two runs. Call it once, outside any retried loop body.
   */
  stage(opts: StageOptions): Promise<string>
}

/** One node of the pre-computed execution plan (what *would* run). */
export interface PlannedNode {
  id: string
  /** "provider/model-id:thinkingLevel" the node will use. */
  model?: string
  /** Planned parent node ids (graph shape for display). */
  parents?: string[]
  /**
   * Declared outputs of the node, for display before it starts: file names
   * resolve under the run's artifact directory, as NodeSpec.outputs do. The
   * node's own spec wins the moment it starts.
   */
  outputs?: Record<string, OutputSpec>
}

/**
 * The firing rule a repo workflow may declare: a cron expression, optionally
 * gated by a check. Only workflows in `<workspace>/.crucible/workflows/` are
 * scheduled; the field is ignored on user and built-in workflows. A schedule
 * never blocks running its workflow by hand.
 */
export interface ScheduleSpec {
  /** Standard 5-field cron (min hour dom mon dow), evaluated in local time. */
  cron: string
  /**
   * Optional gate, evaluated in-process at fire time. Truthy fires the run;
   * falsy leaves no trace anywhere. Day one it is boolean only: no payload
   * reaches the run, which re-queries what it needs.
   */
  check?(ctx: { readonly workspacePath: string }): boolean | Promise<boolean>
}

export interface WorkflowDef {
  /** One line: what a run of this accomplishes. Shown to orchestrators. */
  description: string
  /** Input name -> description. Every input is a path to an existing file. */
  inputs: Record<string, string>
  /**
   * Whether the engine commits whatever the run's worktree holds when the
   * run ends (`crucible: <workflow> <run-id>`). Defaults to true; nothing
   * global ever commits outside the run's own worktree either way. A
   * workflow that wants finer grain commits from its own nodes or run() and
   * sets this false.
   */
  commit?: boolean
  /**
   * Pre-compute the expected node graph from the inputs, before anything
   * runs, so future nodes appear immediately as pending ghosts. Throwing
   * here fails the kickoff — which doubles as input validation. List ONLY
   * the nodes certain to run.
   */
  plan?(inputs: Record<string, string>): PlannedNode[]
  /**
   * Optional firing rule. A scheduled fire supplies no inputs and has no
   * orchestrator, so a workflow that declares both a schedule and inputs is a
   * schedule in permanent warning state on the schedule board; running it by
   * hand with inputs is untouched.
   */
  schedule?: ScheduleSpec
  run(ctx: RunContext): Promise<Record<string, unknown> | void>
}

export function workflow(def: WorkflowDef): WorkflowDef {
  return def
}
