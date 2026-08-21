# 0019 — Cache misses are recorded forever, in one ledger

Everything else Crucible knows about usage dies with the window: the Usage
tab sums π's per-message numbers on the fly and persists nothing, and the
quota cache is a cache. The cache ledger is the exception, on purpose. Every
cache miss Crucible observes on any model turn — sessions and workflow runs
alike — appends one line to a single file under Crucible's own state
directory, and nothing prunes it. The reason is that the questions it exists
to answer are longitudinal: whether one-hour prompt retention pays for itself
on orchestrator sessions that sit waiting on workflows, and whether keeping a
cache warm beats summarizing and restarting from a smaller base. Neither can
be answered from a rolling window, and a miss Crucible filtered out as
uninteresting is a hole in exactly the evidence being reasoned over. So no
miss is judged, no cause is inferred, and the file only grows. Resetting the
sidebar counter appends a reset line rather than deleting anything, which is
what makes "since we changed that setting" a query instead of a memory.

## Considered Options

A rolling window, or clearing on read, was rejected: it makes the common
before-and-after — change a setting, watch whether the misses stop —
impossible to see. Recording only the misses that look like misconfiguration
was rejected for the same reason: an idle-expiry miss is the datum that
decides the retention question, so calling it noise throws away the answer.
Per-workspace files were rejected because the pattern being hunted crosses
workspaces.
