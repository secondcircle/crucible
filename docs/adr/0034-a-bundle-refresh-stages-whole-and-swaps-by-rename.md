# 0034 — A bundle refresh stages whole and swaps by rename

The assembler used to rewrite the installed bundle in place, and an assembly
that died partway — the app quitting out from under its own updater, a hung
copy killed at the timeout — left a plist naming an executable the copy had
already renamed away: the Finder called the app damaged and nothing repaired
it. The assembler therefore builds the next version completely, signature and
all, under a hidden name *inside* the bundle root (`.crucible-next`), then
renames each top-level entry in — one rename of `Contents` on a Mac — so the
launchable names never hold half of two versions and a previous install's
cruft cannot ride along. Inside the bundle rather than beside it because the
directory holding the bundle may not be writable (`/Applications`, most Macs)
while the bundle itself is the user's own, and because staying on the bundle's
volume keeps the swap a rename. The cost is a second copy of the bundle on
disk for the assembly's duration.

## Considered Options

Staging beside the bundle and swapping the bundle directory itself was
rejected: it needs a writable parent, which `/Applications` often is not.
Keeping the in-place rewrite and reordering it so the plist is never
inconsistent was rejected: every ordering still has a window where a kill
leaves mixed versions, and none removes stale files. Windows keeps the
per-file rename-aside merge as the fallback for an entry the OS refuses to
rename while files in it are loaded.
