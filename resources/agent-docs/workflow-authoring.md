# Writing a Crucible workflow

A workflow is one TypeScript file that default-exports a definition. Drop it
in a workflow folder and it exists — file name is workflow name, no
registry, no build step:

- `<workspace>/.crucible/workflows/` — this repository only.
- `~/.crucible/workflows/` — every workspace on this machine.

Workspace overrides user, so a workspace file shadowing a user file's name
replaces it here. Crucible ships no workflows of its own: every workflow is
authored, usually by an agent reading this page. What Crucible does ship is
complete examples — see the end of this page — to copy into a workflow
folder and adapt.

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
- `schedule` — optional, workspace workflows only: the firing rule, below.
- `commit` — optional, default `true`: when the run ends, Crucible commits
  whatever its worktree holds as `crucible: <workflow> <run-id>`. Set
  `false` when the workflow commits for itself and strays should not be
  swept up.
- `run(ctx)` — the workflow. Plain TypeScript: loops, branches on verdicts,
  whatever the orchestration needs. Its return value lands on the run
  record as `outputs`.

## Firing on a schedule

A workflow in `<workspace>/.crucible/workflows/` may declare a schedule.
While Crucible is running, the scheduler fires it for that workspace — no
session, no orchestrator, no inputs:

```ts
export default workflow({
  description: 'label and prioritize untriaged issues',
  inputs: {},
  schedule: {
    cron: '*/5 * * * *',
    check: ({ workspacePath }) =>
      execFileSync('gh', ['issue', 'list', '--label', 'untriaged', '--json', 'number'], {
        cwd: workspacePath,
        encoding: 'utf8'
      }).trim() !== '[]'
  },
  run: async (ctx) => { /* … */ }
})
```

- `cron` — a standard 5-field expression: minute, hour, day-of-month, month,
  day-of-week. `*`, lists (`,`), ranges (`-`), steps (`/`) and numeric values;
  day-of-week 0–7 with both 0 and 7 meaning Sunday. Evaluated in the machine's
  local time. No names for days or months, no presets, no plain English.
- `check` — optional gate, evaluated in the main process at fire time, outside
  any worktree and with the app's own privileges, exactly as this file was
  loaded. It receives `{ workspacePath }` and nothing else. Truthy fires the
  run; falsy leaves no trace anywhere — no run, no worktree, no board entry.
  Day one it is boolean only: nothing it computed reaches the run, which
  re-queries whatever it needs. A check that throws, rejects or takes longer
  than 30 seconds puts the schedule in a warning state on the schedule board;
  it never fires and never lights the chip.

What a scheduled fire is: `git fetch --prune origin`, then a run branched from
the trunk tip, in a worktree of its own, with no inputs and no orchestrator. A
run that finishes clean lands on the schedule board as a one-line summary —
`outputs.summary` when the workflow returns one — with its `report` artifact
rendered beside it. A run that stops on a question, a stall or a failure parks
there until the user takes it to a session or dismisses it.

So a scheduled workflow declares **no inputs**: there is nobody to supply
them. One that declares both a `schedule` and an `inputs` record sits on the
board in a permanent warning state saying so, and never fires on the clock;
running it by hand with its inputs is untouched, as it is for every schedule.

Timing is deliberately loose. The scheduler evaluates at least once a minute,
and a schedule is due when a slot has passed since it was last considered. If
Crucible was closed when slots passed, the first evaluation after launch fires
once — late and unbothered, never once per missed slot. While a previous
scheduled run of the same workflow is still live, a due slot is skipped
entirely and the check is not even evaluated.

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
  - `tools` — built-in tool names; defaults to
    read/bash/edit/write/grep/find/ls.
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

## Complete examples, shipped beside these docs

`examples/`, in the same directory as this file, holds full workflows that
once shipped as built-ins. They are reference material only — the engine
never loads them from there. Copy one into a workflow folder, rename it,
and adapt:

- `examples/adhoc.ts` — the smallest useful workflow: one node running a
  prompt file in the run's worktree, declaring a report artifact so the run
  is inspectable from the graph.
- `examples/adr-audit.ts` — a multi-node pipeline with no inputs at all:
  audit, sweep and report nodes chained through `reads`, doctrine text
  shipped inside the file so replacing the workflow replaces the rule and
  its enforcement in one act, and commits made from `run()` so the branch
  tells the story. Declaring no inputs is what makes a workflow schedulable.
- `examples/build.ts` — the big one: an intent document to built code.
  A Spec node, a fresh-context builder, a bounded review loop with
  `ctx.openNode`/`revise`, verdict schemas branching the orchestration, a
  check-in via `ctx.ask` when reviews keep arguing, and a merge gate that
  loops until it approves. Its header comment carries guidance for the
  orchestrator that runs it. This is the workflow the align flow feeds —
  see `align-flow.md` beside this file.

A typical ask — "a workflow that works through issues labeled `ready` on a
nightly cron" — is a small composition of what is on this page: a
`schedule` with a `check` that queries the issue host (`gh issue list …`),
no inputs, and a `run()` that re-queries the label, then loops issues
through nodes shaped like the examples' — or stages a follow-up run per
issue with `ctx.stage`.
