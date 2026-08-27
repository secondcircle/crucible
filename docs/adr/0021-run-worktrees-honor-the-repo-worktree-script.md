# 0021 — Run worktrees honor the repo's worktree script, and Crucible verifies the result

ADR 0014 delegated worktree creation to `.crucible/worktree` for sessions
only: a run's worktree was always plain git plus `.crucible/worktree-setup`,
because a run's base is a commit named at kickoff and the bare script
contract had no way to receive it. Issue #17 showed where that breaks: a
repository whose checkouts need creation-time provisioning that setup cannot
safely replicate — the concrete case allocates every checkout an isolated dev
slot inside a hardened critical section in the repo's own creation script —
can give a session a full environment but never a run. Run agents there build
and test but cannot start the dev server, so the agents most in need of a
disposable full environment are the ones that cannot have it. We decided the
one script serves runs too. When `.crucible/worktree` exists, Crucible
invokes it for a run's worktree and tells it the base commit and, for a
chained successor, the branch to continue; the script handles both cases,
including the forced checkout a continued branch needs (the branch is still
checked out in the predecessor's kept worktree), and reports a ready worktree
exactly as it does for a session. Crucible then verifies: the reported
worktree must sit at the requested base commit, and on the continued branch
when chained. A mismatch or a failure refuses the run at kickoff, script
output shown, before a node has cost anything. Repositories with no script
are untouched — plain git plus setup, as before. How the base and branch
reach the script (arguments or environment) is the implementation's choice,
recorded exactly in the agent docs that ship the contract, which are a
deliverable of equal rank: an agent told "make run worktrees work here" must
be able to write a passing script from the docs alone.

## Considered Options

Keeping runs on plain git — the prior shape, recorded in ADR 0018 — was
rejected because duplicating creation-time provisioning inside
`worktree-setup` is exactly the drift-prone copy the owning script exists to
prevent, and 0018's original worry (a naive script silently breaking chains)
is answered by verification rather than by exclusion. A separate
`.crucible/run-worktree` script was rejected because nothing functional
distinguishes making a session's worktree usable from making a run's, so a
second file splits one repository concern in two, and a repo that writes only
the session script silently leaves its runs unprovisioned. Trusting the
script without verification was rejected because a stale session-only script
would ignore the base and the run would work on the wrong commit with nobody
seeing it.
