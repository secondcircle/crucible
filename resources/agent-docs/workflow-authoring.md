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

## Where your code runs

The file runs in a workflow host: a process of its own, started for the run
and ended with it, never in Crucible's main process. Every method on `ctx` is
a message to the engine and resolves when the engine answers, which is why
all of them are async, `derive` included. The engine, the node sessions, the
run record and the window are all on the other side of that message.

Synchronous work is allowed and holds only your host. It holds it entirely,
though: while `spawnSync` waits, nothing the engine sends reaches your code,
and a cancel ends the process where it stands rather than letting the file
finish. A short `git rev-parse` is fine either way. A test suite is not: run
it inside a node, where an agent can read its output, or asynchronously with
`execFile`, so a cancel lands between calls instead of killing one. A file
that exits, or that throws at import, fails its run with the process's
stderr on the run's error.

The manifest, the declarations minus the functions, is read once per change
to the file's bytes, by a host started for that and closed after. A run
always imports the file afresh in a host of its own, so a helper the file
imports is read live by every run.

## The smallest real workflow

```ts
import { readFileSync } from 'node:fs'
import { artifactPaths, workflow } from 'crucible:workflow'

export default workflow({
  description: 'one node running a prompt file, in a worktree',
  inputs: { prompt: "A file containing the node's task, used verbatim." },
  plan: () => [{ id: 'work' }],
  run: async (ctx) => {
    const outputs = { report: { file: 'report.html', desc: 'what was done and why' } }
    const result = await ctx.node('work', {
      system: 'You are one node of an automated run; nobody is watching. Work autonomously.',
      prompt: `${readFileSync(ctx.inputs.prompt, 'utf8').trim()}

Write a report of what you did and why to \`${artifactPaths(ctx, outputs).report}\`.`,
      reads: [ctx.inputs.prompt],
      outputs
    })
    return { summary: result.summary }
  }
})
```

The node is told the system prompt and the task, verbatim, and nothing more:
that is why the prompt names the report's path itself. See "What a node is
told" below.

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

### Synchronous work holds your host, entirely

Nothing you do can freeze Crucible's window, but a blocked host is deaf: no
engine message reaches your code while a synchronous call is in flight, and
nothing bounds it. A cancel arriving then kills the process mid-call instead
of letting the file wind down.

So: `spawn` and await it, never `spawnSync` or `execFileSync`; `node:fs/promises`,
not `readFileSync` of anything an agent may have grown. A synchronous
`npm test` in a `run()` body is minutes during which the run cannot be
stopped cleanly. Run a suite inside a node, where an agent reads its output,
or with `execFile` and an await.

```ts
import { spawn } from 'node:child_process'

function git(args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn('git', args, { cwd })
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    child.on('close', (code) => resolve({ ok: code === 0, out: out.trim() }))
  })
}
```

The shipped `adr-audit` and `build` examples use exactly this helper.
`plan(inputs)` and a node's `check(outputs)` run in a host too, under the
same rule; `check` may return a promise, and `plan` is awaited.

## Firing on a schedule

A workflow in `<workspace>/.crucible/workflows/` may declare a schedule.
While Crucible is running, the scheduler fires it for that workspace — no
session, no orchestrator, no inputs:

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export default workflow({
  description: 'label and prioritize untriaged issues',
  inputs: {},
  schedule: {
    cron: '*/5 * * * *',
    // Awaited, never execFileSync: a check the scheduler stops waiting for
    // is a host it kills, mid-call and all.
    check: async ({ workspacePath }) => {
      const listed = await run('gh', ['issue', 'list', '--label', 'untriaged', '--json', 'number'], {
        cwd: workspacePath
      })
      return listed.stdout.trim() !== '[]'
    }
  },
  run: async (ctx) => { /* … */ }
})
```

- `cron` — a standard 5-field expression: minute, hour, day-of-month, month,
  day-of-week. `*`, lists (`,`), ranges (`-`), steps (`/`) and numeric values;
  day-of-week 0–7 with both 0 and 7 meaning Sunday. Evaluated in the machine's
  local time. No names for days or months, no presets, no plain English.
- `check` — optional gate, evaluated in a workflow host at fire time, outside
  any worktree and with the app's own privileges, exactly as this file was
  loaded. It receives `{ workspacePath }` and nothing else. Truthy fires the
  run; falsy leaves no trace anywhere — no run, no worktree, no board entry.
  Day one it is boolean only: nothing it computed reaches the run, which
  re-queries whatever it needs. A check that throws, rejects or takes longer
  than 30 seconds puts the schedule in a warning state on the schedule board;
  it never fires and never lights the chip, and a check still running at the
  30-second mark is a host the scheduler kills, however deep in a synchronous
  call it is. Do the work asynchronously and await it anyway: a check that
  gives its own loop back is one whose timeouts and cleanup still get to run
  before the 30 seconds are up.

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
  - `system` — the node's system prompt, verbatim, after Crucible's short
    opening; optional. Absent means the opening alone. See "What a node is
    told".
  - `prompt` — the node's first user message, verbatim: the task. Keep it
    locally scoped: the node knows nothing about other nodes, and nothing
    about its inputs or outputs beyond what this text says.
  - `reads` — absolute paths of required inputs; the node fails preflight
    when one is missing. Reads that are another node's outputs become graph
    edges automatically. The node is not told these paths; the prompt does
    that.
  - `outputs` — name to `{ file, desc }`. Files are created under the
    artifact directory, and the node is not complete until every one exists
    and is non-empty. `artifactPaths(ctx, outputs)` gives the resolved paths
    to write into the prompt.
  - `verdict` — a JSON Schema object (subset: `type`, `properties`,
    `required`, `enum`, `const`, `items`). The node must pass a matching
    `verdict` argument to `complete_node`; the workflow branches on
    `result.verdict`. The schema reaches the model through the tool's
    parameter schema, never through the prompt.
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
    run's worktree offers — workspace, user and built-in, so the shipped
    `firecrawl` skill included — which is the default and usually right; an
    empty list means none at all, for a node that wants a lean context. A
    name matching no skill is ignored.

A node's `bash` runs on this machine, in the worktree, with the app's PATH.
Whatever is installed here — `git`, `gh`, `firecrawl` — a node can run, and
no spec declares it. A tool that has to be connected (firecrawl is, under
Settings → Research) is connected once per machine, and that reaches runs
too; `research.md` beside this file has the details.
  - `check(outputs, verdict)` — deterministic lint over the output paths;
    returned problems go back into the same agent session as a rejection.
    `verdict` is the node's verdict once it matched the declared shape
    (undefined otherwise), so a lint can hold a document to the word the
    agent gave. Runs in your host, and may return a promise.
- `ctx.openNode(id, spec)` — like `node()`, but the session is held open so
  feedback can re-enter the same context: `opened.revise(message, { from })`
  appends a revision node (`id·r1`, `id·r2`, …) and resolves with the next
  validated completion. Always `close()` it eventually.
- `ctx.ask({ reason, artifacts })` — a check-in. `reason` reaches the
  orchestrating session's agent verbatim, so write it as a prompt; the
  answer comes back verbatim. The run parks with no timeout. Answers are
  recorded, so a resumed run is handed back what it was already told rather
  than asking again.
- `ctx.notify({ reason, artifacts })` — a message with no question in it.
  `reason` and the artifacts reach the orchestrating session's agent the
  way a check-in's do, the message says no answer is expected, and the run
  carries on: it resolves once the message is handed over. For what the
  orchestrator should hear now but need not decide — a finding no node in
  this run may act on, a document the workflow wrote between nodes. Prefer
  it over `ask` whenever the run can proceed without the answer; a
  check-in parks the run and costs the orchestrator a turn it has to
  finish. Notifications are recorded, so a resumed run does not send the
  same one twice.
- `ctx.effect(id, produce)` — do something once per run, whatever happens to
  the run in between. `produce` runs the first time and its result is
  recorded under `id`; a resumed run is handed that result back instead of
  executing it again. The result must survive a JSON round trip, and what
  comes back is the round-tripped value on the first run as well, so the two
  cannot differ. Each id may be recorded once per run — reuse one and the
  run fails, as two nodes sharing an id do. See below for what to wrap.
- `await ctx.derive(path, fromNodeId)` — register a file the workflow itself
  wrote as produced by a node, so later readers get a real graph parent.
  Rejects when the node does not exist.
- `ctx.stage({ workflow, inputs })` — schedule a successor run. The name
  resolves through the origin ladder at stage time; the engine starts the
  successor only when this run completes cleanly, in a fresh worktree
  continuing this run's branch from its final commit. Inputs may name files
  this run has not written yet — they are checked when the successor starts.
  Not idempotent: two calls stage two runs.

## What a resume re-executes, and what it replays

A run survives Crucible quitting, and a resume picks it up where it stopped.
The way it does that is to **execute your `run()` again from the top**, over
the record the previous life wrote. So:

- A node that completed is handed back from its record: its outputs, its
  verdict, its summary. No session, no spend.
- The node the run stopped on continues in its own session, from its last
  turn. Its conversation, artifacts and spend are kept.
- A `ctx.ask` that was answered hands back that answer, and asks nobody.
- A `ctx.notify` that was sent is not sent again.
- A `ctx.effect` that was recorded hands back its value.
- **Everything else in `run()` runs again, for real.** Your loops, your
  branches, your `spawn` calls, your commits, your reads of `git rev-parse
  HEAD`. The engine cannot know that a command you ran was expensive, or
  that running it twice is wrong.

That last line is the whole of what you have to think about. Wrap the work
between nodes that must not happen twice — a gate that takes minutes, a
merge, a commit hash the rest of the run measures against — in
`ctx.effect`:

```ts
// Re-executed on every resume: three minutes each time, and a red result
// from load the replay itself created.
const gate = await sh('make check', ctx.cwd)

// Run once per run, whatever happens to the run.
const gate = await ctx.effect('gate-1', () => sh('make check', ctx.cwd))
```

The id is yours and must be unique within the run, so a gate inside a loop
names its round: `ctx.effect(\`gate-${round}\`, ...)`. The same goes for a
base commit read at the top of a step — recorded once, the resumed run
diffs against the same commit the first one did:

```ts
const base = await ctx.effect(`base-${step}`, () => sh('git rev-parse HEAD', ctx.cwd))
```

Leave the cheap and the idempotent alone: reading a file, computing a
prompt, checking whether a branch exists. Wrapping those buys nothing and
fills the record with noise.

## What a node is told

What the workflow file says, after one short opening of Crucible's. A node's
conversation opens with two pieces of text, both yours:

- `system` — the node's system prompt, sent verbatim and whole. Optional:
  leave it out and the node gets Crucible's opening alone, which knows
  nothing about runs, outputs or finishing. Put here what is true of the
  node's situation rather than its task: that it is one node of an automated
  run, that nobody is watching or will answer a question typed into a
  message, what standard its work is held to. Several nodes of one workflow
  usually share one.
- `prompt` — the node's first user message, sent verbatim. The task.

The opening is a few fixed lines naming the agent a coding assistant that
reads files, runs commands and edits code, the same for every node of every
workflow; it exists so that every request Crucible sends looks like one of
Crucible's own, and it is never the model runtime's stock prompt. Beyond it,
Crucible adds nothing to either text. No role preamble, no list of the files
the node reads, no list of the files it must write, no verdict schema, no
reminder to finish. A word the node is told is either in that opening or in
the workflow file, and a word in neither place was never sent. That rule is
what lets you read a file and know what its nodes cost.

Two things do reach a node from outside the file, and neither is Crucible's
text. The worktree's `AGENTS.md` (and any in its parent directories) arrives
the way the model runtime delivers it to every agent it runs, as project
context appended after the system prompt; that text is the repository's. And
the two tools every node gets carry their own contract in their descriptions:

- `complete_node(summary, verdict?)` — the only way a node finishes. Its
  description says that ending a message is not completion, that the call
  belongs after every declared output is written, that the run validates
  the outputs and rejects the call in the same conversation when one is
  missing, empty or fails its `check`, and that `verdict` is required when
  a schema is declared and must be a plain JSON object matching it. The
  schema itself is spliced into the tool's parameter schema, so the model
  reads the exact shape where it reads the tool.
- `raise_blocker(reason, details?, artifact?)` — parks the node and routes
  the question to the orchestrator. Its description says that nobody reads a
  node's messages, that this is the one channel for a question, and that
  after calling it the node ends its turn and the answer arrives as its next
  message.

Because nothing else says where an output goes, your prompt has to. The
paths are fixed before the node starts: `artifactPaths(ctx, outputs)`
resolves a declared `outputs` record to the absolute paths the engine will
validate and hand back in `result.outputs`, so declare the outputs once,
resolve them, and write the paths into the prompt:

```ts
import { artifactPaths, workflow } from 'crucible:workflow'

const outputs = { review: { file: 'review.md', desc: 'the branch judged' } }
const paths = artifactPaths(ctx, outputs)
await ctx.node('review', {
  system: NODE_SYSTEM,
  prompt: `Review the branch and write your findings to \`${paths.review}\`. …`,
  reads: [intent],
  outputs,
  verdict: VERDICT
})
```

The same goes for inputs: `reads` makes the engine check a file exists and
draws a graph edge, but the node learns the path only if the prompt names
it. A prompt that says "the earlier rounds are listed among your inputs"
describes a list nobody sends; name the files. And a verdict-bearing prompt
says in words what the verdict is (`approved` or `changes-required`, with a
`reason`), since the schema reaches the model only through the tool.

A node that ends its turn without calling either tool is nudged, then stalled
out to the orchestrator; those nudges, the rejection carrying `check`
problems, and the answer to a blocker are the engine's replies to something
the node did, and they are not part of the prompt you wrote.

## Habits that hold up

- Fresh context is the design. Push everything a node needs through the
  prompt, with `reads` declaring the files it names; never assume it saw
  another node's conversation, or that it knows a path you did not write.
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
