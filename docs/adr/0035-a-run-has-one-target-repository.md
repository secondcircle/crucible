# 0035 — A run has exactly one target repository, which may sit inside the workspace

A workspace is not always one repository. The case that forced this is a
workspace folder that is a small repository of its own (a whitelist
`.gitignore` tracking only its wiki, `AGENTS.md` and `.crucible/`) with several
independent repositories cloned beside those files as subfolders, where almost
every code change lands. Every run got a worktree of the root repository,
which does not even contain the subfolders, so a workflow that had to change
one made, committed and reported its own worktree in workflow code, while
Crucible committed, showed and resumed a root worktree nothing used. We
decided a run has exactly one **target repository**: the workspace's own by
default, or a repository whose top sits inside the workspace folder, named as
a path relative to that folder. Everything a run does to a repository happens
in its target. That covers the worktree, every node's working directory, the
commit at the end, the branch and worktree its completion names, and where
resume and a chained successor continue. The orchestrator names the target at
kickoff. A workflow may declare it instead, either as one fixed target (a
scheduled run has nobody to choose) or as "a target is required", which
refuses a kickoff that names none. A kickoff whose target disagrees with the
workflow's fixed one is refused, never resolved silently. So is a target that
is outside the folder, missing, or a plain subfolder of the workspace's own
repository. What stays at the workspace is the workflows (still discovered
from its `.crucible/workflows/`), the orchestrator, the run's place in the UI,
and the context a node starts with. A targeted run's nodes get the
workspace's skills and `AGENTS.md` as well as the target worktree's, wherever
the worktree ended up.

## What this changes elsewhere

ADR 0016's base commit now resolves in the target repository. An interactive
kickoff with no base branches from the target's HEAD, and a named base such as
`main` means the target's `main`. ADR 0021's contract, like ADR 0014 and
0018's scripts, is read from the target repository's `.crucible/`, not the
workspace's. Its verification is unchanged. A plain-git run worktree goes
under the target's own `.crucible/worktrees/`, inside the workspace folder, so
nodes also pick up the workspace's `AGENTS.md` by the ordinary parent walk.
ADR 0023's scheduled fire fetches and branches from the target repository's
trunk. A run record written before this decision means the workspace's
repository. Sessions are untouched: a session's checkout or worktree is still
of the workspace's repository (ADR 0013).

## Considered Options

Leaving it to workflow code, the prior state, was rejected: every workflow
that changes a component repository repeats the same plumbing, and the
engine's picture of the run stays wrong. A run spanning several repositories
was rejected on the owner's rule that one run changes one repository, and
because it would turn every branch, commit, resume and chain into a set. A
choice by the workflow alone was rejected because the workflow that motivated
this changes a different repository per request. A choice by the orchestrator
alone was rejected because a scheduled run has none. Letting the kickoff
silently override the workflow, or the reverse, was rejected because either
way the run ends up in a repository somebody did not choose. Leaving a node's
context to wherever the target's own worktree script placed the worktree was
rejected, because what a node knows would then depend on a placement detail.
