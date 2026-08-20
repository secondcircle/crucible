#!/bin/bash
# main moved in this clone, so rebuild /Applications/Crucible.app from it.
#
# Every hook that can move main calls this one script: post-merge (a merge or
# a fast-forward pull), post-commit (a plain commit, a cherry-pick, a revert,
# a conflicted merge concluded by hand) and post-rewrite (an amend or a
# rebase). Nothing here interrupts the human: the build runs in the
# background, and the running app notices the new stamp and offers the
# restart pill on its own.
#
# Wired by: git config core.hooksPath scripts/git-hooks
set -u

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
[ "$branch" = "main" ] || exit 0

root="$(git rev-parse --show-toplevel)"

# install-stable refuses a dirty tree, so say why here rather than leave a
# refusal in a log nobody opened.
if [ -n "$(git status --porcelain)" ]; then
  echo "install-stable: skipped — the tree is dirty, so the stamp could not name a real commit."
  exit 0
fi

# What the human is already running. Reading it here means an amend (which
# fires post-commit and post-rewrite both) builds once, and a hook firing
# with nothing new to say costs nothing. No asar, so this is a plain file;
# missing means no installed app, which is a reason to build, not to skip.
head="$(git rev-parse --short HEAD)"
# The override exists so the test can point at a stamp of its own; nothing
# else sets it, and no agent may run this against the real bundle.
stamp="${CRUCIBLE_INSTALLED_STAMP:-/Applications/Crucible.app/Contents/Resources/app/out/build-stamp.json}"
installed="$(sed -n 's/.*"commit": *"\([^"]*\)".*/\1/p' "$stamp" 2>/dev/null)"
if [ "$installed" = "$head" ]; then
  echo "install-stable: /Applications/Crucible.app is already $head."
  exit 0
fi

mkdir -p "$root/logs"
lock="$root/logs/.install-stable.lock"

# Two builds at once would race over dist/ and over /Applications itself. The
# holder re-reads HEAD when it finishes, so whatever this fire would have
# built gets built by that run instead.
if ! mkdir "$lock" 2>/dev/null; then
  echo "install-stable: a build is already running; it will pick up $head when it finishes."
  exit 0
fi

echo "install-stable: main is at $head — building in the background → logs/install-stable.log"

# git points the hook at this commit's index; the build must not inherit that.
unset GIT_INDEX_FILE GIT_DIR GIT_WORK_TREE GIT_PREFIX

(
  trap 'rmdir "$lock" 2>/dev/null' EXIT
  cd "$root" || exit 1
  # main can move again mid-build — an amend, another commit. Build until the
  # commit that was built is the one main is on.
  while :; do
    building="$(git rev-parse HEAD)"
    npm run install:stable || break
    [ "$(git rev-parse HEAD)" = "$building" ] && break
    echo
    echo "install-stable: main moved during the build — building again."
  done
) > "$root/logs/install-stable.log" 2>&1 &

disown 2>/dev/null || true
