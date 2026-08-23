# Writing a Crucible workflow

A workflow is one TypeScript file that default-exports a definition. Drop it
in a workflow folder and it exists — file name is workflow name, no
registry, no build step:

- `<workspace>/.crucible/workflows/` — this repository only.
- `~/.crucible/workflows/` — every workspace on this machine.
- Built-ins ship with Crucible. Workspace overrides user overrides built-in,
  so shadowing a built-in's name replaces it here.

Crucible loads the file with a TypeScript-aware loader; `crucible:workflow`
resolves to the authoring module without any `node_modules` in the folder.
Node's own modules (`node:fs`, `node:child_process`) import as usual.

## The smallest real workflow

```ts
import { readFileSync } from 'node:fs'
import { workflow } from 'crucible:workflow'

export default workflow({
  description: 'one node running a prompt file, in a worktree',
  inputs: { prompt: "A file containing the node's task, used verbatim." },
  plan: () => [{ id: 'work' }],
  run: async (ctx) => {
    const result = await ctx.node('work', {
      prompt: readFileSync(ctx.inputs.prompt, 'utf8').trim(),
      reads: [ctx.inputs.prompt],
      outputs: { report: { file: 'report.html', desc: 'what was done and why' } }
    })
    return { summary: result.summary }
  }
})
```

## The definition

- `description` — one line; what the orchestrator's catalog shows.
- `inputs` — input name to one-line description. Every input is a path to an
  existing file, checked before the run starts. No other input kinds exist:
  parameters that are not files go inside a file.
- `plan(inputs)` — optional. The nodes certain to run, so they appear as
  pending ghosts in the graph from the first moment. Throwing here fails the
  kickoff, which makes it the place for input validation. List only what is
  certain: the plan is a floor, not a guess.
- `commit` — optional, default `true`: when the run ends, Crucible commits
  whatever its worktree holds as `crucible: <workflow> <run-id>`. Set
  `false` when the workflow commits for itself and strays should not be
  swept up.
- `run(ctx)` — the workflow. Plain TypeScript: loops, branches on verdicts,
  whatever the orchestration needs. Its return value lands on the run
  record as `outputs`.

## The run context

Every run works in a fresh git worktree branched from a commit named at
kickoff. `ctx.cwd` is that worktree; every node's tools work there.
`ctx.artifactDir` is the run's own artifact directory, outside the
repository — node outputs land there, never in the worktree.

- `ctx.node(id, spec)` — one agent node; resolves when it completes. The
  spec:
  - `prompt` — the node's task, verbatim. Keep it locally scoped: the node
    knows nothing about other nodes.
  - `reads` — absolute paths of required inputs; the node fails preflight
    when one is missing. Reads that are another node's outputs become graph
    edges automatically.
  - `outputs` — name to `{ file, desc }`. Files are created under the
    artifact directory, and the node is not complete until every one exists
    and is non-empty.
  - `verdict` — a JSON Schema object (subset: `type`, `properties`,
    `required`, `enum`, `const`, `items`). The node must pass a matching
    `verdict` argument to `complete_node`; the workflow branches on
    `result.verdict`.
  - `model` — `"provider/model-id:thinkingLevel"`, e.g.
    `"anthropic/claude-opus-5:high"`. Omitted means the engine's default.
    `thinkingLevel` is π's name for the suffix and the reason it reads that
    way here, but what it sets is effort, and effort governs the whole turn
    rather than the depth of thinking alone. Lower it and the node makes
    fewer tool calls, writes less preamble and answers more tersely; raise it
    and it searches harder before it acts. Pick by how much work the node
    should do, not by how hard you want it to think: a node that reads three
    files and fills in a template wants a low level, a node that has to find
    something wants a high one. It is a poor lever for output length, which a
    node prompt controls better by saying what to write.
  - `tools` — built-in tool names; defaults to
    read/bash/edit/write/grep/find/ls.
  - `skills` — skill names this node may use. Omitted means every skill the
    run's worktree offers, which is the default and usually right; an empty
    list means none at all, for a node that wants a lean context. A name
    matching no skill is ignored.
  - `check(outputs)` — deterministic lint over the output paths; returned
    problems go back into the same agent session as a rejection.
- `ctx.openNode(id, spec)` — like `node()`, but the session is held open so
  feedback can re-enter the same context: `opened.revise(message, { from })`
  appends a revision node (`id·r1`, `id·r2`, …) and resolves with the next
  validated completion. Always `close()` it eventually.
- `ctx.ask({ reason, artifacts })` — a check-in. `reason` reaches the
  orchestrating session's agent verbatim, so write it as a prompt; the
  answer comes back verbatim. The run parks with no timeout.
- `ctx.derive(path, fromNodeId)` — register a file the workflow itself wrote
  as produced by a node, so later readers get a real graph parent.
- `ctx.stage({ workflow, inputs })` — schedule a successor run. The name
  resolves through the origin ladder at stage time; the engine starts the
  successor only when this run completes cleanly, in a fresh worktree
  continuing this run's branch from its final commit. Inputs may name files
  this run has not written yet — they are checked when the successor starts.
  Not idempotent: two calls stage two runs.

## What a node is told

Before your prompt arrives, the engine has already given the node a role
prompt. Do not restate any of it. Verbatim, it tells the node that it has no
interactive user and works autonomously; that its task lists required input
files and it should read the ones it needs; that it must produce every
declared output file with real, complete content; that it is not done until
it calls `complete_node`, and ending a message is not completion; that a
broken environment or malformed input means `raise_blocker` rather than
improvising or asking in plain text, because nobody is reading plain text;
that after raising one it stops and waits; and that it must never fabricate a
result, but verify claims by running tools.

So a node prompt that opens with "you are an autonomous agent", or closes by
reminding the node to call `complete_node` and not to make things up, is
spending its opening and closing lines on what the node was already told.
Write the task instead.

Every node is a fresh agent with no interactive user. Beyond its built-in
tools it gets exactly two more: `complete_node(summary, verdict?)` — the
only way a node finishes — and `raise_blocker(reason, details?, artifact?)`,
which parks the node and routes the question to the orchestrator. A node
that ends its turn without calling either is nudged, then stalled out to
the orchestrator. Output validation failures are delivered back into the
same session, so fixes happen with full context.

## Habits that hold up

- Fresh context is the design. Push everything a node needs through `reads`
  and the prompt; never assume it saw another node's conversation.
- Commit meaningful stages from `run()` with ordinary git (the run's
  worktree is `ctx.cwd`), so the branch tells the story of the run.
- Make verdicts small and closed — an enum and a reason beats free text the
  workflow then has to parse.
- `ctx.ask` is expensive attention: reserve it for judgment only the
  session that started the run can supply.
