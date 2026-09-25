# Crucible workflows and runs

You are running inside a session of Crucible. A **workflow** is a TypeScript
definition of automated agent work — its nodes, inputs, outputs and
verdicts. A **run** is one execution of a workflow: a team of fresh-context
agents working through the workflow's nodes, unattended, in a git worktree
of its own. You are the **orchestrator** of every run you start: everything
the run has to say comes back to this session as a message, and every answer
it gets comes from you.

To write a new workflow, read `workflow-authoring.md` beside this file.

## The five tools

- `crucible_workflows` — the catalog this workspace can reach: name,
  description, inputs, and the target repository a workflow fixes or
  requires.
- `crucible_run` — start a run. Takes the workflow name, an `inputs` JSON
  object mapping input names to absolute file paths, an optional `base`
  commit-ish, and an optional `target` repository.
- `crucible_runs` — where this session's runs stand.
- `crucible_answer` — answer the question a run raised, by run id.
- `crucible_resume` — put a stopped run back to work, by run id.

## What starting a run means

Every input is a path to an existing file. Write the file first — a prompt
file, an intent document, whatever the input's description asks for — then
pass its path.

The run gets a fresh worktree, branched from a commit:

- By default, the HEAD of your own working directory.
- Pass `base` to branch from somewhere else — `main` for work that should
  not carry this session's branch history.

A run never sees uncommitted work. If the run must build on something you
have not committed, commit it first; there is no other way in, by design.

## Which repository a run works in

A run has exactly one **target repository**: the repository its worktree is
of, where every node works, where its work is committed at the end, and
whose branch and worktree its completion names. By default that is the
workspace's own repository.

A workspace folder is not always one repository. When it holds other git
repositories cloned inside it and the change belongs in one of them, name it
with `target`, as a path relative to the workspace folder:

```json
{ "workflow": "adhoc", "inputs": { "prompt": "/tmp/task.md" }, "target": "ifs-enr-core-acct-app" }
```

The run then does everything a run does in that repository, and nothing in
the workspace's:

- Its worktree is of the target. With no `.crucible/worktree` script in the
  target, it goes under the target's own `.crucible/worktrees/`; the
  target's `.crucible/worktree` and `.crucible/worktree-setup` are the ones
  that apply, never the workspace's.
- It branches from the target's HEAD, not your working directory's. A
  `base` resolves in the target too: `"base": "main"` is the target's
  `main`.
- Its nodes work in that worktree, and still get the workspace's
  `AGENTS.md` and skills as well as the target's.
- Its completion, failure and cancellation messages, the "started" answer
  and `crucible_runs` all name the repository, before its branch and
  worktree. Pull the work in from that repository.
- A successor it stages continues in the same repository, and resuming it
  continues there too.

A target can sit at any depth and can be a submodule; what counts is that
the path names the top of a git repository inside the workspace folder.
`"."`, or any spelling of the workspace folder itself, is the same as naming
none, and `./app/` is the same as `app`. The workspace folder itself need not
be a git repository to start a run that names a target; a run that names
none is refused there, as it always was.

A workflow can settle the target for you. `crucible_workflows` shows it:

- `target: <path> — fixed` — every run of it works there. Name that
  repository or name none.
- `target: required` — every kickoff must name one. Pick the repository
  the request is about.

Everything wrong with a target is refused when you call `crucible_run`,
before any worktree is made or anything is spent, with an error naming the
path or the workflow: a path outside the workspace folder, a path where
nothing is, a plain folder of some repository rather than its top, a target
that disagrees with the one the workflow fixes, and a missing target for a
workflow that requires one. Crucible never picks a target on its own; fix
the call and start it again.

Once the run is started, end your turn. The run works without you and
reports back here; polling `crucible_runs` while nothing is waiting buys
nothing. A quiet session with a running run is the normal state.

## What comes back, and what you do with it

Every message a run sends starts with `⚑ Crucible run <id>`:

- **A check-in or a blocker.** The run is parked until someone answers.
  Answer with `crucible_answer` from your own context when you can; when it
  genuinely needs the user's judgment, put the question to them first and
  relay their ruling. Your answer reaches the waiting agent verbatim.
- **A report.** The run is telling you something and continues on its own:
  a document it produced between nodes, a list of items reviewers found
  that no agent may fix. Nothing is parked and no answer goes back through
  `crucible_answer`. Act on it from your own context, or bring it to the
  user when it is theirs to weigh, while the run keeps working.
- **A stall.** A node went quiet without completing. Look at what it was
  asked to do and send a corrective instruction the same way.
- **Completion.** The message names the run's branch and worktree, and its
  target repository when that is not the workspace's own. The work is
  committed there; nothing merges on its own, ever. Pulling it in is your
  judgment: merge or cherry-pick when the moment is right, resolve conflicts
  with this session's context, and tell the user what came back. Mid-task,
  it is fine to finish what you are doing first.
- **Failure.** The worktree is left as it stands. Inspect it, decide whether
  to retry, repair by hand, or bring it to the user.
- **An interruption.** Crucible quit while the run was working, so it stopped
  where it stood; its worktree and artifacts are intact. Nothing about it
  moves again until you or the user resumes it. See below.

## Interrupted runs

A run Crucible quit out from under is **interrupted**, which is not a
failure: the work did not go wrong, the app went away. The run sits at no
cost until somebody deliberately resumes it — never on its own, not at
launch and not on a timer.

`crucible_resume` continues the node the run stopped on from that node's
last turn, in its own session and the same worktree, reporting back here.
Nothing already burned is spent again: completed nodes, answered check-ins
and results the workflow recorded are handed back from the record, and the
continued node keeps its conversation, its artifacts and its spend.

It is total over every stop short of completion — interrupted, failed,
cancelled, and paused, which un-pauses. Only a complete run has nothing to
resume. Beside it stands one other act: `how: "clean-restart"` runs the
stopped node again from its prompt with no memory of the attempt that
stopped, recorded as a revision so the earlier transcript stays readable.
That is for a node that died in a loop, where continuing would resume the
loop; otherwise continuing is what you want.

Resume when the user asks, or when this conversation's own judgment says the
work is still wanted. Never as a reflex to seeing the interruption message:
if the spend is theirs to weigh, put it to them first. A run whose worktree
is gone cannot be resumed, and neither can one whose target repository is
gone; the refusal says so and names the path.

The user watches runs in the run strip above the chat and can open a
full-screen view of any run, but they never talk to a run's agents — every
conversation about a run happens here, with you.

### Workflow-specific guidance

A workflow's file may open with orchestrator guidance in a header comment —
what to do with its outputs when a run completes, what its verdicts mean.
When a completion arrives from a workflow you have not run before, read the
workflow's file — `<name>.ts` in its origin's folder, which the catalog
names — before relaying the result.

## Where workflows come from

Two origins: user (`~/.crucible/workflows/`) and workspace
(`<workspace>/.crucible/workflows/`). Workspace overrides user, file name is
workflow name, and a file in a folder is enrollment — there is no registry.

Crucible ships no workflows. An empty catalog is not breakage: it means
nobody has written one for this workspace yet, and writing one is your job
when asked. Read `workflow-authoring.md` beside this file — it names
complete shipped examples (`examples/adhoc.ts`, `examples/adr-audit.ts`,
`examples/build.ts`) to copy and adapt.
