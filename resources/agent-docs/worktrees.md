# Crucible worktrees

You are running inside a session of Crucible. Every session works in exactly
one of two places: the workspace's own checkout, or a git worktree created for
that session alone. The user picks in the composer, before the session's first
message, with the chip that reads `◇ checkout` or `⑂ <branch>`.

This page tells you how the creation works, so that when the user asks you to
make worktrees work in this repository you can write the script and it works
on the very next flip.

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

So a script is worth writing when the fallback is not enough: the repository
needs env files copied in, dependencies installed, a branch name that satisfies
a workplace policy, or a location other than `.crucible/worktrees/`.

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
