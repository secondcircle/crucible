# 0026 — A stopped run resumes only when somebody says so, and never loses work

Every way a run stops short of completing — the app quitting out from under it
(interrupted), the work going wrong (failed), somebody stopping it
(cancelled) — leaves the same thing behind: a worktree as it stands and a node
that was mid-flight. So Resume is total over all three, and over paused, which
un-pauses. Only a complete run has nothing to resume: it is done. A run that
refuses to resume because of which stop it suffered is an arbitrary loss of
work, and the whole point of keeping the worktree is that the work is not lost.

Resume continues the stopped node from its last turn: its conversation, its
artifacts and its spend are kept, and nothing already burned is spent again.
Beside it stands one other act, a clean restart, which runs the node again
from its prompt as a revision — for the node that died in a loop, where
continuing would resume the loop. A clean restart never destroys the earlier
attempt's transcript, and spend accumulates across attempts.

The system itself still never resumes anything — not at launch, not on a
timer — for the same reason the update pill waits for a click: paid work must
never fire at a moment nobody chose. There are exactly two hands, as there
always were: the human's Resume click in the run view and an agent's resume
tool call.

## Considered Options

Auto-resume at launch was rejected: a restart with three interrupted runs
would silently start three paid jobs. Human-only resume was rejected because
an orchestrator told "pick it back up" should be able to do so without
sending the user to a button. Resuming by re-running the stopped node from its
beginning — the original shape — was rejected once the cost was named: it
throws away every turn the node had done and bills them again. Extending
resume to complete runs was rejected as a different feature: reworking
finished work is not resuming.
