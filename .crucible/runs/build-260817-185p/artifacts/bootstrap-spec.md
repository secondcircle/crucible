# Bootstrap the worktree contract for `/Users/ike/repos/crucible`

**Auto-generated spec · staged, not started.** Crucible tried to run
`build` in a disposable git worktree of this repository and could not:
the repository has no `make validate` target (verdict `no-validate-target`). Nothing ran in that worktree; it was removed. This spec
asks for the missing piece so the next worktree run works. Authorize it only
if you want this repository to support worktree runs.

## The bet

A background run should never race the human's edits. The worktree venue gives
each run its own checkout on its own branch — but only if a *fresh* checkout of
this repo can be made development-ready without a human. That is what the two
Makefile targets below promise. Today this repo does not keep that promise.

## The contract to implement

- `make validate` — exit 0 **iff** this checkout is development-ready.
  Required. Whatever "ready" means here: typecheck, build, unit tests, lint —
  the repo's own bar, not a new one.
- `make provision` — optional, and only if `validate` cannot pass in a bare
  checkout. Run once in a fresh worktree to make `validate` passable:
  dependency installs, untracked local config (`.env.local`), scratch
  directories, per-checkout ports or database names. **Must be idempotent** —
  running it twice must leave the same state and still exit 0.
- Both must work in a worktree that lives *alongside* an existing checkout of
  this repo, at the same time. Anything a second checkout would collide on
  (fixed ports, a shared database name, a global lock, an absolute path baked
  into config) has to be derived per-checkout instead. How is this repo's
  business; Crucible only runs the two targets.
- Do not weaken `validate` to make it pass. If the honest bar is expensive,
  keep it expensive.

## Scope

- The Makefile (or the scripts it calls) and whatever per-checkout config the
  provision step needs.
- Nothing else. Do not restructure the build, rename scripts other repos call,
  or "improve" unrelated tooling.

## Done looks like

Demonstrated, not asserted — run it and paste the evidence in your notes:

1. `git worktree add <repo>/.crucible/worktrees/bootstrap-check HEAD` creates a
   fresh checkout while the live checkout stays in place.
2. In that worktree: `make -n validate` and (if you added it) `make -n
   provision` both resolve — the targets exist.
3. `make provision && make validate` succeeds there, **with the original
   checkout still present and usable**.
4. Running `make provision && make validate` a **second time** in the same
   worktree still exits 0 (idempotence).
5. `git worktree remove --force <repo>/.crucible/worktrees/bootstrap-check`
   cleans up; leave no stray branch behind.
6. `.crucible/` (or at least `.crucible/worktrees/`) is git-ignored.

## Evidence from the failed preflight

The run that triggered this: `build-260817-185p` · workflow `build` · branch
`crucible/build-260817-185p` · worktree `/Users/ike/repos/crucible/.crucible/worktrees/crucible-build-260817-185p` (removed).

Full log: `/Users/ike/repos/crucible/.crucible/runs/build-260817-185p/artifacts/preflight.log`

```
venue: worktree · branch crucible/build-260817-185p · repo /Users/ike/repos/crucible
$ git worktree add -b crucible/build-260817-185p /Users/ike/repos/crucible/.crucible/worktrees/crucible-build-260817-185p HEAD
exit 0
HEAD is now at fe2e47c Seam sketch for the Electron boilerplate milestone
Preparing worktree (new branch 'crucible/build-260817-185p')

$ make -n validate
exit 2
make: *** No rule to make target `validate'.  Stop.

preflight verdict: no-validate-target
$ git worktree remove --force /Users/ike/repos/crucible/.crucible/worktrees/crucible-build-260817-185p
exit 0
(no output)

$ git worktree prune
exit 0
(no output)

removed the fresh worktree /Users/ike/repos/crucible/.crucible/worktrees/crucible-build-260817-185p
```
