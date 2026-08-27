# 0026 — An interrupted run never resumes on its own

A run that Crucible quit out from under is marked interrupted and sits at no
cost, worktree intact, until someone deliberately resumes it. There are
exactly two hands that can: the human's Resume click in the run view, and an
agent's resume tool call. The system itself never resumes one — not at
launch, not on a timer — for the same reason the update pill waits for a
click: paid work must never fire at a moment nobody chose. Resuming re-runs
the interrupted node from its beginning, which re-spends whatever that node
had already burned, and only a person or an agent acting in a conversation
can judge whether that spend is still worth it.

## Considered Options

Auto-resume at launch was rejected: a restart with three interrupted runs
would silently start three paid jobs. Human-only resume was rejected because
an orchestrator told "pick it back up" should be able to do so without
sending the user to a button.
