# Crucible worktrees

You are running inside a session of Crucible. Every session works in exactly
one of two places: the workspace's own checkout, or a git worktree created for
that session alone. The user picks in the composer, before the session's first
message, with the chip that reads `◇ checkout` or `⑂ <branch>`.

Workflow runs get worktrees too, one each, and never the checkout.

This page tells you how the creation works, so that when the user asks you to
make worktrees work in this repository you can write the script and it works
on the very next flip.

There are two scripts a repository can write, and they answer different
questions:

- `.crucible/worktree` makes a worktree. It replaces Crucible's git entirely,
  so it decides the location, the branch and the base. Sessions only.
- `.crucible/worktree-setup` makes a worktree usable. Crucible has already
  created it; the script installs, copies, generates. Runs and sessions both.

If you only write one, write `worktree-setup`. It is smaller, it is what runs
need, and most repositories are fine with Crucible's plain git otherwise.

## What happens when the user flips the chip

Crucible looks for an executable file at `.crucible/worktree` inside the
workspace folder.

- The file is there: it is the whole mechanism. Crucible runs it and uses what
  it reports. There is no fallback behind it, and a file that exists but fails
  is a failure the user sees, never a quiet retry with git.
- The file is not there: Crucible runs plain
  `git worktree add -b crucible/<random> .crucible/worktrees/<random>` from the
  checkout, on a branch off the checkout's current HEAD. It also drops a
  `.gitignore` containing `*` in `.crucible/worktrees/` so the directory never
  shows up as untracked noise.

So `.crucible/worktree` is worth writing when the fallback puts the worktree in
the wrong place or on the wrong branch: a branch name that satisfies a
workplace policy, or a location outside `.crucible/worktrees/`. If all the
repository needs is setting up afterwards, write `.crucible/worktree-setup`
instead and leave the git to Crucible.

## The script contract

Write it at `.crucible/worktree` inside the workspace folder, and make it
executable (`chmod +x .crucible/worktree`). Crucible refuses to run a file it
cannot execute and shows the user why, so do not skip this.

Any language. The shebang decides.

Crucible runs it with the checkout as the working directory, with no arguments
and no Crucible-specific environment variables. Everything it needs it must
work out for itself. Where the worktree goes, what branch it lands on, which
env files get copied, whether dependencies are installed: all of it is the
script's business and none of it is Crucible's.

What it has to do:

- Leave a ready worktree on disk. Ready means the session can start working in
  it immediately: checked out, plus whatever setup this repository needs.
- Print the worktree's absolute path. Crucible reads the last non-empty line of
  stdout, trimmed, and nothing else. Anything before that line is yours: log
  what you like, and the user sees it only if the script fails.
- Exit 0 when the worktree is ready. Any other status is a failure.

On a failure Crucible shows the user the first line naming what failed, then
the script's stdout and stderr exactly as they came out, and leaves the session
on the checkout. Nothing is cleaned up, so write your errors for the person who
has to fix them.

Crucible also checks the reported path: it must be absolute and it must be a
directory that exists. A script that exits 0 and prints something else is a
failure like any other.

After a success Crucible reads the worktree's branch with
`git branch --show-current` to label the chip. A worktree with no branch on it
still works; the chip shows the directory's name instead.

## An example

```bash
#!/usr/bin/env bash
set -euo pipefail

id="$(date +%s)-$RANDOM"
path="$HOME/worktrees/$(basename "$PWD")-$id"

git worktree add -b "wt/$id" "$path" HEAD >&2

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
with plain git, before anything else uses it. Workflow runs always create their
worktrees this way, which is why this is the script that matters for them: a
run whose nodes cannot build spends its whole budget discovering that.

Write it at `.crucible/worktree-setup` inside the workspace folder and make it
executable (`chmod +x .crucible/worktree-setup`). Any language.

Crucible runs it with **the new worktree** as the working directory, with no
arguments and no Crucible-specific environment variables. Exit 0 means ready;
anything else is a failure. On a failure a session stays on the checkout, and a
run is refused at kickoff before a single node has cost anything — the script's
whole output is what the user is shown, so write your errors for the person who
has to fix them.

Crucible does not run it after `.crucible/worktree`. That script is the whole
mechanism and reports a *ready* worktree, so if it wants this one it calls it
itself.

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
instant — this repository's own script does exactly that, and falls back to a
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
checkout detaches its worktree and leaves that on disk too.

Cleanup is a human or an agent act, with ordinary git:

```bash
git worktree remove <path>     # a worktree whose work is done
git worktree prune             # entries whose directories are already gone
git branch -d <branch>         # the branch, once it has landed
```

Ask before removing anything. A worktree that looks abandoned may hold the only
copy of work in progress.
