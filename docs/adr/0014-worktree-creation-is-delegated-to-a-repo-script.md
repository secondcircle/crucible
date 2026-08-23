# 0014 — Worktree creation is delegated to a repo script, with a plain-git fallback

Not every repository is worktree-friendly: a fresh worktree may need env
files, installs, or a branch name that satisfies a workplace policy, and no
Crucible release can anticipate all of it. We decided Crucible shells out:
when an executable `<workspace>/.crucible/worktree` exists it is the whole
mechanism — run from the checkout with no arguments, last line of stdout is
the absolute path of the ready worktree, exit 0 means ready — and when it is
absent, Crucible falls back to plain `git worktree add` on a generic branch
(`crucible/…`) from the checkout's HEAD, under `.crucible/worktrees/` with a
self-ignoring `.gitignore`. The script's territory is the worktrees sessions
ask for: it takes no base argument, so a run's worktree — branched from a
commit named at kickoff — is always plain git, made by Crucible itself
(ADR 0016, ADR 0018). The contract ships in the agent docs
(`resources/agent-docs/`), so any repo's agent can be told "make worktrees
work here" and write the script. Branch names are throwaway at creation;
when work is ready to merge or PR, the session's agent renames the branch to
whatever policy demands — ordinary git, no Crucible machinery.

## Considered Options

Script-only was rejected because repos with no setup needs would see no
worktree feature until someone wrote a script. The legacy Makefile contract
(`make provision` / `make validate`, Crucible owning the git mechanics) was
rejected because it kept naming and layout policy in Crucible, exactly what
work repositories need to own.
