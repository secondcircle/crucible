# 0013 — Isolation is a session property, not a run property

The legacy system gave every workflow run a venue (local or worktree) and
policed the shared live checkout with dirty holds and a local-venue lock;
issue #1 records the structural failure: ordinary chat residue in the
checkout silently held runs that were supposed to start unattended. We
decided isolation moves to session creation: a session works either in the
workspace's checkout or in a git worktree created for it alone, chosen
before its first message and changeable again only after a session reset,
and workflows carry no venue concept at all: a run never chooses a venue,
because every run works in a worktree of its own, branched from a commit
named at kickoff (ADR 0016). This deletes venue config, dirty holds, and
the local lock in exchange for worktree machinery at the session layer, and
future workflow output stays ordinary branches the human merges or PRs.

## Considered Options

Per-run venue configuration (the legacy shape) was rejected because any
concurrent work in the checkout could hold an unattended run — the
contention between "a session works in the live checkout" and "runs need a
clean base" is structural, not fixable by better holds.
