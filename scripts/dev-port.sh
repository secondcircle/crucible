#!/bin/bash
# The Chromium remote debugging port for THIS checkout.
#
# One port per checkout, so two dev launches never contend: the primary clone
# keeps 9222 (the port AGENTS.md documents and everyone has in muscle memory),
# and every linked worktree derives a stable port of its own from its path. A
# given worktree therefore always answers on the same port, run after run, with
# no registry and no allocation step.
#
# Contention was the whole cause of agents reaching for `pkill`, so removing it
# is what keeps the installed app safe. Nothing here kills anything.
set -euo pipefail

# An explicit override wins, for the rare case of driving two launches out of
# one checkout.
if [ -n "${CRUCIBLE_DEBUG_PORT:-}" ]; then
  echo "$CRUCIBLE_DEBUG_PORT"
  exit 0
fi

root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "$root/.git")"

# In the primary clone the common git dir sits inside the checkout; in a linked
# worktree it points back at the primary. That difference is the whole test.
if [ "$common" = "$root/.git" ]; then
  echo 9222
  exit 0
fi

# 9223-9292: stable in the checkout's path, clear of 9222, and well inside the
# ephemeral range. cksum is in POSIX, so this needs nothing installed.
hash="$(printf '%s' "$root" | cksum | cut -d' ' -f1)"
echo $((9223 + hash % 70))
