# 0018 — Making a worktree usable is a second repo script

ADR 0014 delegates worktree *creation* to `.crucible/worktree`, which is the
whole mechanism when it exists — it picks the location and, told a run's
base, serves runs too (ADR 0021). A repository with no script gets plain
git from Crucible, and plain git leaves a checkout rather than a working
environment: no
installed dependencies, no env file, nothing generated. A run's nodes are
told to run the project's checks, so the whole budget goes on discovering
that the worktree cannot build. We decided the two questions are separate and
get separate scripts: `.crucible/worktree` still makes a worktree, and
`.crucible/worktree-setup` makes one usable — run inside a worktree Crucible
has already created, no arguments, exit 0 means ready. Crucible runs it
wherever it made the worktree itself with plain git — any run or session in
a repository without the script; it does not run it after `.crucible/worktree`,
because that script reports a *ready* worktree and can call this one itself.

## Consequences

A repository that needs only setting up writes one small script instead of
reimplementing git worktree creation. A run whose setup fails is refused at
kickoff, before a node has cost anything, rather than failing three nodes
deep. Repositories that have neither script are exactly as they were.
Crucible now reads two files from `.crucible/`, and both are contracts that
are painful to rename once repositories have written them.

## Considered Options

Having Crucible install dependencies itself was
rejected as ADR 0014 rejected the Makefile contract: it puts a guess about
every ecosystem in Crucible. Leaving it to the node agents was rejected
because it is the model paying, every node, every run, to rediscover the same
fact.
