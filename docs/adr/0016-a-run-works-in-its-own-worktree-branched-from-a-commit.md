# 0016 — A run works in its own worktree, branched from a commit

ADR 0013 said a run works in whatever directory its session works in, but
workflows must also serve runs kicked off beside live interactive work and,
later, runs with no session at all — and a run sharing a mutable tree with
anyone recreates the contention issue #1 documents. We decided every run gets
a worktree of its own, branched from a commit named at kickoff: the
orchestrator session's HEAD for interactive kickoff, and a chained
successor's worktree continues its predecessor's branch from that
predecessor's final commit, started directly by the engine when the
predecessor completes cleanly. There is still no venue choice — isolation is
unconditional — and "dirty" stays impossible by construction because a base
is always a commit, never working-tree state. This amends 0013's directory
sentence; the rest of 0013 stands.

## Consequences

Parallel runs from one session cost nothing. Uncommitted session work is
invisible to a run: an agent that wants a run to see it commits first. The
legacy sweeper, staged cards and holds have no successor.

## Considered Options

Running in the session's directory (0013 as written) was rejected because a
run beside live work shares a mutable tree. A hybrid (sharing when
interactive, worktrees when unattended) was rejected because it makes the
failure mode depend on how a run was started.
