# The align flow

You are running inside a session of Crucible. This page explains the shape
work takes here: an alignment first, an issue as its product, and a workflow
run that builds from the issue. The alignment part is global — the same two
commands in every workspace — while the building part is authored per
repository as a workflow.

## What alignment produces

An alignment is an interview: the user states an intent, the agent asks only
the questions with real functional trade-offs, prototypes anything
non-obvious, and writes the settled scope into an **intent brief**. Two
built-in commands run it, and they end differently:

- `/align` — the thorough interview: glossary entries and ADRs as terms and
  decisions crystallize, prototypes built and approved along the way. On the
  confirming yes it creates an **align issue** on the workspace's issue
  host: labeled `align`, its body the intent brief, its prototypes attached.
  The brief is never written into the repository — the issue is the durable
  artifact, and the `align` label is the marker a build workflow looks for.
- `/quick-align` — the fast one: end-user experience only, a handful of
  questions, technical shape left entirely to the implementation. On the
  confirming yes it writes the brief to a local file in `.crucible/align/`
  at the workspace root, prototypes beside it — a folder it proves is
  gitignored before writing. No issue is created; the file is the product,
  and it never enters the repository's history.

## Which issue host (`/align` only)

The workspace's existing configuration decides, never a question:

- `.crucible/jira.json` present → Jira. The issue is created in the
  configured project, type Task, label `align`, prototypes attached through
  the attachments API. To set a repository up with Jira — credentials,
  config, all of it — read `jira.md` beside this file.
- Otherwise → GitHub through `gh`. The label is created if missing, the
  issue takes the brief as its body, and prototype files go in one secret
  gist linked from the brief, since GitHub issues take no attachments.

## From issue to built code

The typical shape, end to end:

1. The user aligns — `/align` leaves an align issue, `/quick-align` a brief
   file under `.crucible/align/`.
2. A build workflow takes the intent brief as its input and runs unattended:
   spec, build, review, merge gate. `examples/build.ts` beside these docs is
   a complete one to copy into `.crucible/workflows/` and adapt; read
   `workflow-authoring.md` first.
3. What comes back is a branch, judged against the brief. Merging stays the
   human's act.

How a build run gets its issue is the repository's choice, authored into its
workflow:

- **By hand**: the user points a session at an issue, the agent writes the
  brief to a temp file and starts the run with it.
- **On a schedule**: a workspace workflow declares a cron with a `check`
  that queries the host for open `align`-labeled issues (`gh issue list
  --label align …`), and its `run()` re-queries, picks one, and works it.
  The scheduling contract is in `workflow-authoring.md`.

Nothing here is fixed machinery: the interview and the issue are the stable
convention, and everything after the issue is an authored workflow.
