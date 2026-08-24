# 0024 — A schedule check is code, not a run

Some schedules fire far more often than their work is needed: every five
minutes one asks whether untriaged issues exist, and most answers are no.
We decided the asking is plain TypeScript — an optional check beside the
cron expression, evaluated by the scheduler in the main process. A falsy
result leaves no trace: no run, no worktree, no agent, no board entry. Only
a truthy result starts a run, which is then ordinary in every way (ADR
0023). A check that throws puts its schedule into a warning state on the
schedule board, last error shown; it never lights the chip.

## Consequences

Cheap polling costs nothing and clutters nothing; the board's Recent group
holds only runs that did work. The check runs with the app's own privileges
outside any worktree, like the workflow definitions the engine already
loads. A broken check is visible only on the board, so a user who never
opens it can miss a dead schedule.

## Considered Options

Running the check as a workflow of its own was rejected: every poll would
cost a worktree and an agent and land on the board. Recording skipped fires
as no-op runs was rejected as the exact spam this avoids. Lighting the chip
on repeated check failure was rejected for now — the user reads the board
regularly.
