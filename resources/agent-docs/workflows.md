# Crucible workflows and runs

You are running inside a session of Crucible. A **workflow** is a TypeScript
definition of automated agent work — its nodes, inputs, outputs and
verdicts. A **run** is one execution of a workflow: a team of fresh-context
agents working through the workflow's nodes, unattended, in a git worktree
of its own. You are the **orchestrator** of every run you start: everything
the run has to say comes back to this session as a message, and every answer
it gets comes from you.

To write a new workflow, read `workflow-authoring.md` beside this file.

## The four tools

- `crucible_workflows` — the catalog this workspace can reach: name,
  description, inputs.
- `crucible_run` — start a run. Takes the workflow name, an `inputs` JSON
  object mapping input names to absolute file paths, and an optional `base`
  commit-ish.
- `crucible_runs` — where this session's runs stand.
- `crucible_answer` — answer the question a run raised, by run id.

## What starting a run means

Every input is a path to an existing file. Write the file first — a prompt
for `adhoc`, an intent document for `build` — then pass its path.

The run gets a fresh worktree, branched from a commit:

- By default, the HEAD of your own working directory.
- Pass `base` to branch from somewhere else — `main` for work that should
  not carry this session's branch history.

A run never sees uncommitted work. If the run must build on something you
have not committed, commit it first; there is no other way in, by design.

Once the run is started, end your turn. The run works without you and
reports back here; polling `crucible_runs` while nothing is waiting buys
nothing. A quiet session with a running run is the normal state.

## What comes back, and what you do with it

Every message a run sends starts with `⚑ Crucible run <id>`:

- **A check-in or a blocker.** The run is parked until someone answers.
  Answer with `crucible_answer` from your own context when you can; when it
  genuinely needs the user's judgment, put the question to them first and
  relay their ruling. Your answer reaches the waiting agent verbatim.
- **A stall.** A node went quiet without completing. Look at what it was
  asked to do and send a corrective instruction the same way.
- **Completion.** The message names the run's branch and worktree. The work
  is committed there; nothing merges on its own, ever. Pulling it in is your
  judgment: merge or cherry-pick when the moment is right, resolve conflicts
  with this session's context, and tell the user what came back. Mid-task,
  it is fine to finish what you are doing first.
- **Failure.** The worktree is left as it stands. Inspect it, decide whether
  to retry, repair by hand, or bring it to the user.

The user watches runs in the run strip above the chat and can open a
full-screen view of any run, but they never talk to a run's agents — every
conversation about a run happens here, with you.

## Where workflows come from

Three origins, exactly like commands: built-in (shipped with Crucible),
user (`~/.crucible/workflows/`), workspace (`<workspace>/.crucible/workflows/`).
Workspace overrides user overrides built-in, file name is workflow name, and
a file in a folder is enrollment — there is no registry.
