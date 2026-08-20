# 0015 — Crucible never reads or writes π's state

Crucible is built on the π SDK, so the temptation is to treat π's directory as
shared ground: the quota work first cached its readings in `~/.pi/agent/usage/`
in the legacy system's on-disk format, honouring `PI_CODING_AGENT_DIR`, so that
every app on the machine would share one cache and none would pay twice for the
same minute. That is a real benefit, and it was still wrong. `.pi` belongs to π
and to the TUI that lives there. Crucible reading or writing it invents a
file-format contract with another program that nobody agreed to, freezes both
sides to a schema neither owns, and quietly escapes the split that keeps a dev
launch from touching the installed app's state.

So: Crucible reads and writes nothing under `.pi`, ever, and `PI_CODING_AGENT_DIR`
means nothing here. Crucible's own state lives under Crucible's `userData`,
which is already flavor-scoped (`Crucible` installed, `Crucible-Dev` in dev, and
a per-worktree directory under that for runs), and anything Crucible caches goes
there. The cost is accepted in full: two apps on one machine fetch the same
provider separately, and the rate-limit budget pays for both.

Asking the π SDK for something through its API is a different act and stays
allowed — `ModelRuntime.getAuth()` is π reading π's files on our behalf, which
is what an SDK is for. The line is the filesystem: we call π's code, we never
open π's files.
