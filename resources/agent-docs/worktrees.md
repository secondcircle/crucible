# Crucible worktrees

You are running inside a session of Crucible. Every session works in exactly
one of two places: the workspace's own checkout, or a git worktree created for
that session alone. The user picks in the composer, before the session's first
message, with the chip that reads `◇ checkout` or `⑂ <branch>`.

Workflow runs get worktrees too, one each, and never the checkout.

This page tells you how the creation works, so that when the user asks you to
make worktrees work in this repository you can write the script and it works
on the very next flip, and on the next run.

There are two scripts a repository can write, and they answer different
questions:

- `.crucible/worktree` makes a worktree. It replaces Crucible's git entirely,
  so it decides the location, the branch and the base. Sessions and runs both.
- `.crucible/worktree-setup` makes a worktree usable. Crucible has already
  created it with plain git; the script installs, copies, generates. Sessions
  and runs both, in a repository that has no `.crucible/worktree`.

Write `.crucible/worktree-setup` if all this repository needs is installing and
copying after an ordinary checkout. It is the smaller job and most
repositories are fine with Crucible's plain git otherwise. Write
`.crucible/worktree` when creation itself has to be owned here: a location
outside `.crucible/worktrees/`, a branch name that satisfies a workplace
policy, or provisioning that can only happen as the checkout is made, such as
claiming an isolated dev slot.

## When Crucible runs the script

Crucible looks for a file at `.crucible/worktree` inside the workspace folder,
both when the user flips a session's chip and when a run needs its worktree.

- The file is there: it is the whole mechanism. Crucible runs it and uses what
  it reports. There is no fallback behind it, and a file that exists but fails
  is a failure the user sees, never a quiet retry with git. Presence decides,
  not executability: a file Crucible cannot execute is a failure too.
- The file is not there: Crucible runs plain `git worktree add` from the
  checkout, under `.crucible/worktrees/`. A session gets a branch
  `crucible/<random>` off the checkout's current HEAD; a run gets
  `crucible/run-<id>` at its base commit, or a forced checkout of the branch
  it continues. Crucible also drops a `.gitignore` containing `*` in
  `.crucible/worktrees/` so the directory never shows up as untracked noise,
  and then runs `.crucible/worktree-setup` in what it made.

## The script contract

Write it at `.crucible/worktree` inside the workspace folder, and make it
executable (`chmod +x .crucible/worktree`). Crucible refuses to run a file it
cannot execute and shows the user why, so do not skip this.

Any language. The shebang decides.

Crucible runs it with the checkout as the working directory and no arguments.
What it is making is told through two environment variables, and which of them
exist is how the script knows which of the three jobs this is:

| The job                   | `CRUCIBLE_WORKTREE_BASE`                | `CRUCIBLE_WORKTREE_BRANCH` |
| ------------------------- | --------------------------------------- | -------------------------- |
| A session                 | unset                                   | unset                      |
| A fresh run               | the run's base, a full sha              | unset                      |
| A run continuing a branch | the commit to continue from, a full sha | the branch to continue     |

Unset means the variable is not in the environment at all, so
`[ -n "${CRUCIBLE_WORKTREE_BRANCH:-}" ]` is the whole test. The base always
arrives as a full sha, resolved in the checkout before the script is invoked,
so there is nothing to interpret and nothing to look up.

What to do in each case:

- **`CRUCIBLE_WORKTREE_BRANCH` set.** A run is continuing the branch its
  predecessor was working on, from that predecessor's final commit. Check that
  existing branch out in a new worktree, and force it:
  `git worktree add --force "$path" "$CRUCIBLE_WORKTREE_BRANCH"`. The force is
  not optional. The branch is still checked out in the predecessor's worktree,
  which Crucible keeps forever, and git refuses a second checkout of a branch
  without it.
- **`CRUCIBLE_WORKTREE_BASE` set, no branch.** A fresh run. Create a worktree
  on a new branch of your own naming, at exactly that commit:
  `git worktree add -b "<your name>" "$path" "$CRUCIBLE_WORKTREE_BASE"`. Not
  HEAD, which is wherever the checkout happens to be; the commit you were
  given. A run must end up on a branch, so do not use `--detach`.
- **Neither set.** A session. The script picks everything, base included.

Everything else is yours in all three cases: where the worktree goes, which
env files get copied, whether dependencies are installed, what the branch is
called for a session or a fresh run.

What the script has to do, whichever job it is:

- Leave a ready worktree on disk. Ready means work can start in it
  immediately: checked out, plus whatever setup this repository needs.
- Print the worktree's absolute path. Crucible reads the last non-empty line
  of stdout, trimmed, and nothing else. Anything before that line is yours:
  log what you like, and the user sees it only if the script fails.
- Exit 0 when the worktree is ready. Any other status is a failure.

There is no timeout. The script owns how long it takes.

## Exit 0 is not the end of it: what Crucible verifies

For a session, Crucible checks the reported path and nothing else: it must be
absolute and a directory that exists. The branch is then read with
`git branch --show-current` only to label the chip. A session's worktree with
no branch on it still works; the chip shows the directory's name instead.

For a run, the same path check applies and three more follow it, because a run
that works on the wrong commit is money spent on the wrong thing and nobody
would see it until the branch was read at the end:

1. The worktree's `HEAD` is exactly `CRUCIBLE_WORKTREE_BASE`.
2. The worktree is on a branch. A detached HEAD is a failure: a run's
   completion names its branch, and a successor may have to continue it.
3. When `CRUCIBLE_WORKTREE_BRANCH` was set, the current branch is exactly that
   branch.

A script that reads neither variable will pass for sessions and fail for runs
the moment the checkout's HEAD is anywhere but the run's base. That failure is
the point: it is loud, it is at kickoff, and it names both shas.

## What a failure looks like

Any of it failing refuses the work, and the presentation is always the same:
a first line naming what failed, then the script's stdout and stderr exactly
as they came out. A verification mismatch names what was found against what
was asked for, then shows the script's output for context.

- A session stays on the checkout and the user sees the whole thing.
- A run is refused at kickoff, before a single node has started or cost
  anything. The agent that asked for the run gets the error back; when the
  refused run was a successor staged by another run, its orchestrator is told
  in a message.

Nothing is cleaned up, ever. A worktree the script made before it failed, and
the branch it put on it, are still there afterwards, so write your errors for
the person who has to fix them and leave the wreckage readable.

## An example

```bash
#!/usr/bin/env bash
set -euo pipefail

id="$(date +%s)-$RANDOM"
path="$HOME/worktrees/$(basename "$PWD")-$id"

if [ -n "${CRUCIBLE_WORKTREE_BRANCH:-}" ]; then
  # A run continuing its predecessor's branch. Forced, because that branch is
  # still checked out in the predecessor's worktree, which is kept forever.
  git worktree add --force "$path" "$CRUCIBLE_WORKTREE_BRANCH" >&2
elif [ -n "${CRUCIBLE_WORKTREE_BASE:-}" ]; then
  # A fresh run, at the commit it was given and not at HEAD.
  git worktree add -b "wt/$id" "$path" "$CRUCIBLE_WORKTREE_BASE" >&2
else
  # A session; the script picks everything.
  git worktree add -b "wt/$id" "$path" HEAD >&2
fi

# whatever a working copy of this repository needs before an agent can use it
cp .env "$path/.env"
(cd "$path" && npm ci >&2)

# the last line, and the only one Crucible reads
echo "$path"
```

Note the `>&2`. Keeping chatter off stdout is the simplest way to be sure the
path is the last line. It is not required, since only the last line is read,
but it is the habit that fails least often.

## Making a worktree usable: `.crucible/worktree-setup`

A worktree straight out of git is a checkout, not a working environment. There
is no `node_modules`, no `.env`, nothing generated. An agent that tries to run
the project's checks in one fails on the first command.

So Crucible runs `.crucible/worktree-setup` inside every worktree it creates
with plain git, before anything else uses it. That is every worktree in a
repository with no `.crucible/worktree`: sessions and runs alike.

Write it at `.crucible/worktree-setup` inside the workspace folder and make it
executable (`chmod +x .crucible/worktree-setup`). Any language.

Crucible runs it with **the new worktree** as the working directory, with no
arguments and no Crucible-specific environment variables. Exit 0 means ready;
anything else is a failure. On a failure a session stays on the checkout, and a
run is refused at kickoff before a single node has cost anything. The script's
whole output is what the user is shown, so write your errors for the person who
has to fix them.

Crucible does not run it after `.crucible/worktree`. That script is the whole
mechanism and reports a *ready* worktree, so if it wants this one it calls it
itself, in the worktree it just made.

```bash
#!/usr/bin/env bash
set -euo pipefail

# The main checkout this worktree belongs to.
common="$(git rev-parse --path-format=absolute --git-common-dir)"
checkout="${common%/.git}"

cp "$checkout/.env" .env
npm ci >&2
```

A full install per worktree is often too slow to pay every run. When the
lockfile has not moved, borrowing the checkout's dependencies is sound and
instant. This repository's own script does exactly that, and falls back to a
real `npm ci` when the lockfile differs. Read `.crucible/worktree-setup` here
for the pattern.

## Branch names are throwaway

Neither Crucible nor your script needs to guess a good branch name at creation
time. Nothing has been written yet, so nothing is known about the work.

When the work is ready to merge or to become a pull request, rename the branch
to whatever the repository's policy demands, informed by what the session
actually did. That is your job, with ordinary git:

```bash
git branch -m feat/quota-strip-pace-tick
```

Crucible has no machinery around this and no opinion about the name.

## Crucible never deletes a worktree

Removing a session, resetting a session, and removing a workspace all leave
every worktree exactly where it is. Flipping a fresh session back to the
checkout detaches its worktree and leaves that on disk too. A run's worktree
outlives the run, which is why a continued branch needs a forced checkout.

Cleanup is a human or an agent act, with ordinary git:

```bash
git worktree remove <path>     # a worktree whose work is done
git worktree prune             # entries whose directories are already gone
git branch -d <branch>         # the branch, once it has landed
```

Ask before removing anything. A worktree that looks abandoned may hold the only
copy of work in progress.
