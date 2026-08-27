# Crucible

The ubiquitous language of this repository. Open it before naming anything —
a type, a file, a component, a document heading — and use these words exactly.
`/align` is its only writer.

## Language

**Crucible**:
The whole app: a personal development system built on top of π, whose core is
the workflow engine and whose surface is this Electron app. Not any single
piece of it.
_Avoid_: using "Crucible" to mean only the extensions, only the engine, or
only the UI.

**Legacy system**:
The TUI-based π extension workspace at `../pi-extensions`, where Crucible
first grew. A read-only reference: pieces are chosen and rebuilt here one at a
time, and nothing here depends on it at runtime.
_Avoid_: the old app, the extensions repo.

**Agent port**:
The Crucible-owned interface between the UI layer and everything agent-side.
The only path by which the UI reaches an agent — a hedge against ever leaving
the π SDK, and the seam every UI test runs against.
_Avoid_: SDK wrapper, mock boundary.

**Fake adapter**:
The agent-port implementation that answers with canned responses — no
network, no cost. What agents and tests drive the app with; the default in
dev mode.
_Avoid_: mock, stub.

**SDK adapter**:
The agent-port implementation backed by the real π SDK.
_Avoid_: real backend, live mode.

**Ember**:
The shell's visual language — the palette, typography, spacing, and
component patterns defined by `docs/design/mock-a-ember.html` and its
supporting mocks. The name of the look, not of any feature.
_Avoid_: the theme, the skin, the dark mode.

**Workspace**:
An OS folder opened in Crucible: the home of that folder's sessions and the default place their agents work.
_Avoid_: project, repository.

**Checkout**:
The workspace folder's own git working directory, where a session works unless it has a worktree.
_Avoid_: local, live checkout.

**Worktree**:
A git worktree of the workspace's repository, created for exactly one session to work in place of the checkout, or for exactly one run. Crucible creates worktrees and never deletes them.
_Avoid_: venue, sandbox, branch (a worktree holds a branch; it is not one).

**Worktree setup**:
What turns a freshly created worktree into one an agent can work in: the install, the env file, the generated code. The repository owns it, in an executable `.crucible/worktree-setup` that Crucible runs inside the new worktree. Distinct from worktree *creation*, which `.crucible/worktree` owns.
_Avoid_: provisioning (the rejected Makefile contract's word), bootstrap, init.

**Session**:
A user-curated workspace sidebar item holding one agent conversation. It appears only when the user creates or adds it in Crucible; adapter-managed history never populates the sidebar by discovery.
_Avoid_: thread, chat, backing-store record.

**Session title**:
The short description of what a session is about, written by a small model
from that session's user and assistant messages and refreshed as the session
goes. What the sidebar shows in place of a timestamp.
_Avoid_: session name, summary, label.

**Model alias**:
The short display name Crucible shows for a model it knows by heart — `Opus`
for `Claude Opus 5`. Display only: the picker still lists what the port
reported, under the port's own labels.
_Avoid_: nickname, friendly name, short name.

**Model ring**:
The ordered handful of models Shift-Tab cycles through without opening the
picker. A build-time constant, and nothing in the UI names the key.
_Avoid_: favorites, model cycle, quick switch.

**Steering message**:
A message queued while a session is working, delivered at the next boundary
between tool calls to redirect the live turn. π's meaning, adopted verbatim.
_Avoid_: interrupt, injection, mid-turn message.

**Follow-up message**:
A message queued while a session is working, held until the agent fully
stops, then sent as the next prompt. π's meaning, adopted verbatim.
_Avoid_: queued prompt, deferred message.

**Tool chain**:
A run of consecutive tool calls in a transcript, rendered as one collapsible
element; thinking or assistant text ends one chain and starts the next. A
lone call is a chain of one.
_Avoid_: call group, tool run, tool stack.

**Session tree**:
A session's full branching conversation history, every point ever reached,
navigable to continue from any earlier point. π's tree structure, surfaced
in Crucible's own view.
_Avoid_: history view, checkpoints, timeline.

**Jump**:
Continuing a session from a chosen point in its session tree, in place:
same session, same sidebar identity, every other path preserved in the tree.
_Avoid_: rewind, time travel, checkout, restore.

**Bash run**:
A shell command executed locally in the workspace from the composer's `!`
grammar. Local by default; it touches the conversation only when explicitly
added to it.
_Avoid_: terminal, shell session, bang command.

**Command**:
A markdown prompt template invoked from the composer as `/name args`,
expanded by Crucible itself before the result crosses the agent port. Three
origins: built-in (ships with the app), user, and workspace; workspace
overrides user overrides built-in.
_Avoid_: prompt template (π's mechanism), slash command.

**Skill**:
A folder of instructions an agent reads for itself when its task matches the
skill's description, carrying practice that holds in any repository rather than
anything Crucible-specific. π's format and π's loader, at the same three origins
as commands; a read anywhere inside one shows in the tool chain as `skill`.
_Avoid_: agent doc (that is the Crucible-specific material behind the docs
index), command (a skill is never invoked by the user), plugin, extension.

**Intent brief**:
The durable artifact an alignment interview produces on agreement — the
settled scope and rulings — published as the body of an align issue on the
workspace's issue host, never as a file in the repository. The interview says
nothing about what happens to it next.
_Avoid_: alignment doc, spec, plan.

**Align issue**:
The issue an alignment interview creates on the confirming yes: labeled
`align`, its body the intent brief, its prototypes attached. The marker a
future build chain looks for.
_Avoid_: alignment ticket, brief file, align document.

**Prototype**:
A small artifact built during an alignment interview to de-risk something
non-obvious — an HTML mock for a UI surface, a spike proving a library we
have never used — finished before the align issue is created and shipped
with it.
_Avoid_: spike (alone), proof of concept, demo.

**Context panel**:
The agent-curated display split to the right of the chat area, where a
session's agent shows rendered exhibits — HTML or markdown files, or web
addresses — in tabs. HTML and web exhibits render at full browser fidelity.
Adopted verbatim from the legacy system, tools and all.
_Avoid_: preview pane, artifact viewer, right sidebar.

**Tab**:
One entry in the context panel: a title over one exhibit — a file or a web
address — keyed by path or URL so re-showing the same one refreshes it in
place. Per-session, like the panel itself.
_Avoid_: pane, exhibit slot, window.

**Branch board**:
The workspace-scoped view of every branch the user owns in that repository,
grouped by whether the work has landed, and of the host pull requests that
name the user. It reports; it never deletes or checks out anything.
_Avoid_: git panel, branch manager, PR dashboard.

**Issue board**:
The workspace-scoped view of the issues you could pick up in that repository,
read beside a pane showing one of them in full, and the place work on an issue
starts. It reports and starts sessions; it never closes, assigns, labels or
comments.
_Avoid_: ticket board, issue list, backlog.

**Issue**:
One unit of tracked work on the issue host, whatever that host calls it — a
GitHub issue, later a Jira ticket. Crucible's word for all of them.
_Avoid_: ticket, card, task.

**Issue host**:
The service an issue board reads a workspace's issues from. GitHub Issues
through `gh` today; the board is one host-shaped seam, so others follow
without a new board.
_Avoid_: tracker, ticketing system, provider, integration.

**Picked up**:
An issue that already has work against it in this workspace — a session
started from it, or an open pull request naming it. Grouped apart on the
issue board, never hidden.
_Avoid_: taken, claimed, in progress.

**Landed**:
A branch whose work is already in the trunk — either its commits are
ancestors of the trunk, or the host records its pull request as merged. The
host's record wins where a host is connected, because a squash merge leaves
no ancestry for git to find.
_Avoid_: merged (ambiguous once squashing is in play), stale, dead.

**Session reset**:
Replacement of a session's conversation with a fresh stock π session while keeping the same sidebar identity.
_Avoid_: new session, clear chat.

**Role prompt**:
The replaceable identity of an agent Crucible starts — what kind of agent it
is and the generic guidelines of that job. Authored by Crucible and passed as
a full override; π's stock prompt is never used. Two roles exist today: the
interactive coding agent, and the **node role** every workflow node is started
with — the one that says a node has no interactive user, must produce its
declared outputs, is not done until it calls `complete_node`, raises a blocker
rather than improvising, and never fabricates a result it did not verify. A
node prompt is written on top of that role, not instead of it.
_Avoid_: system prompt (the composed whole), base prompt.

**Quota strip**:
The block at the foot of the sidebar, above Add workspace, showing how much of
each provider subscription this machine has spent. Global: one per app, not per
workspace and not per session.
_Avoid_: usage strip, usage panel (Settings' Usage section means session tokens
and cost), limits, meters panel.

**Quota meter**:
One window of one plan in the quota strip — a short label, a percent used, and
the instant it resets. A provider has as many as its plan reports; nothing in
Crucible fixes the count or the labels. Most meter a percent; the spend meter
meters dollars.
_Avoid_: window (the payload's word, ambiguous beside the context window),
bar, gauge.

**Spend meter**:
The quota meter for an account's monthly dollar budget, labelled `MO` and
printing dollars used over dollars allowed rather than a bare percent. It is
the only meter that contributes no countdown to its row, because a calendar
month needs no counting.
_Avoid_: budget bar, credit meter, overage meter, monthly quota, MO meter.

**Work account**:
An Anthropic subscription that meters a monthly dollar budget and no usage
windows at all: `limits: []` and a live `.spend`. It signs in through the same
OAuth flow as a personal one, so nothing but the payload tells them apart, and
its row carries the spend meter alone.
_Avoid_: enterprise account, team plan, business subscription.

**Pace tick**:
The hairline on a windowed quota meter — weekly or monthly — marking where an
even burn would have put you by now. Fill past the tick means spending faster
than the window elapses.
_Avoid_: velocity, burn rate, forecast, projection line.

**Needs you**:
The state of a session whose turn ended, or errored, while the user was not
looking at it and nothing was working on the user's behalf — marked in the
sidebar until the user lands on that session, and walked by Tab. A session
whose own run is working has something working on its behalf, so its turn
ending is not news; a run that stopped and cannot move without the user is not
working, and the turn carrying that news marks. The branch board's count of
branches and pull requests is a separate thing, spoken of as the board's
need-you count.
_Avoid_: unread, alert, attention flag, notification (the OS banner is one
way a needs-you state is announced, not the state itself).

**Workflow**:
A TypeScript definition of automated agent work — its nodes, inputs,
outputs and verdicts. The template, never the execution: what executes is a
run.
_Avoid_: using "workflow" for a running instance, pipeline, automation.

**Example workflow**:
A complete, runnable workflow file shipped beside the agent docs as reference
material — copied into a `.crucible/workflows/` folder and adapted, never
loaded by the engine from where it ships. Crucible ships no workflows that
run as-is.
_Avoid_: built-in workflow, prefab, template, sample.

**Run**:
One execution of a workflow, working in a worktree of its own branched from
a commit named at kickoff. Observed in the UI, never conversed with: its
questions and results are messages to its orchestrator.
_Avoid_: job, build, using "workflow" for an execution.

**Orchestrator**:
The session agent a run reports to. Every check-in, blocker, error and
completion arrives as a message to it, and any answer a run gets comes from
it — the user talks to the orchestrator, not to a run's agents.
_Avoid_: orchestration agent, initiator session, supervisor.

**Run strip**:
The bar above a session's chat pane where runs appear, one chip each —
workflow, current node, age, spend.
_Avoid_: run bar, pill row, status bar.

**Run activity**:
The sidebar state of a session that has a live run of its own — a teal counter
of the run's age over teal dots in the row's end slot, where a live turn shows
green. Teal is the run color everywhere, chips and ⌘R rows included.
_Avoid_: run indicator, running badge, run status.

**Run artifact**:
A file a node of a run declares as an output and writes into the run's own
directory, outside the repo. The files handed in at kickoff are shown beside
them but are the repo's, not the run's.
_Avoid_: output file, deliverable, exhibit (an exhibit is a context panel tab).

**Schedule**:
The firing rule a repo workflow may declare — a cron expression, optionally
gated by a schedule check, in the workflow file, versioned with the repo. It
starts runs on its own while the app is running and never blocks running
that workflow by hand.
_Avoid_: cron job, timer, automation.

**Schedule check**:
The optional predicate a schedule may declare beside its cron expression —
plain TypeScript the scheduler evaluates in-process at fire time. Falsy
means no run and no record anywhere; truthy fires the run. A check that
errors puts its schedule in a warning state on the schedule board and never
lights the chip.
_Avoid_: trigger, condition, sensor, poll.

**Schedule board**:
The workspace-scoped overlay behind the schedule chip in the top bar:
parked runs first, then every schedule with its cadence and last outcome,
then recent runs and their reports. It reports, toggles schedules, and
hands runs to sessions; it never answers a run itself.
_Avoid_: schedules view, cron panel, automation dashboard.

**Parked**:
The state of a scheduled run stopped on a question, a stall, or a failure
with no orchestrator to hear it. It waits — lighting the schedule chip and
walking with Tab — until a session adopts it or the user dismisses it.
_Avoid_: blocked (π's word for an interactive run's wait), stuck, orphaned.

**Run graph**:
The drawn picture of a run's nodes and the edges between them, layered
top-down in the run view's left pane: what followed what, what fanned out in
parallel, what was sent back for revision. An edge means the work of one node
reached another, and carries no text; a node states what it follows rather
than having it inferred.
_Avoid_: the flow, the graph rail, the DAG view, pipeline diagram.

**Artifact rail**:
The third column of the run view, listing every artifact the run has touched
in production order — inputs first, then what the run wrote — each naming the
node that wrote it and the nodes that read it. Declared outputs appear dimmed
from the moment their node starts.
_Avoid_: artifacts panel, output list, artifact sidebar.

**Artifact reader**:
The rendered view of one artifact, opened in place of the node transcript
while the graph and the artifact rail stay put. Read-only, like the rest of
the run view.
_Avoid_: preview, viewer, artifact tab.

**Merge gate**:
The final phase of a build run: one map-level pass over the whole branch —
coverage against the intent document, scope creep against incidental extras,
mock fidelity, input acknowledgment, comments — that loops until it approves,
and leaves the branch ready for the human to merge. A phase, not a workflow of
its own, and it never merges anything.
_Avoid_: PR review, final review, the gate workflow.

**Design doctrine**:
The rules the build workflow holds a plan and its code to: deep modules
behind small interfaces, testing at the seams, and data representations
that cannot express invalid states — principles, never one language's
constructs. Ships inside the build workflow like the comment doctrine; a
workspace that disagrees replaces the whole workflow.
_Avoid_: design guide, architecture standards, best practices.

**Comment doctrine**:
The rules a comment must satisfy to survive the merge gate: it explains why
something non-obvious was done, in a line or two, referencing nothing outside
the code. Ships with Crucible; a workspace that disagrees replaces the whole
workflow.
_Avoid_: comment style guide, comment policy.

**Cache miss**:
A model turn that re-billed prompt tokens the previous turn had already
paid to cache. π's word and π's arithmetic, adopted verbatim; Crucible
never decides that one was justified.
_Avoid_: cache break (the earlier docs' word), cache invalidation, cache hit
rate.

**Cache ledger**:
The append-only file recording every cache miss Crucible observes, across
every workspace, session and run, plus a line for each counter reset. One
per installation, never pruned: it is the evidence an agent reads when asked
why the misses keep happening.
_Avoid_: cache log, miss history, usage ledger.

**Cache strip**:
The row at the foot of the sidebar counting misses and dollars re-billed
since the last reset, with the reset's date. Global, like the quota strip
below it, and it opens the cache health view.
_Avoid_: cache badge (that is the per-session one in the top bar), cache
meter, cache counter.

**Cache expiry choice**:
The dialog raised when a send would certainly re-bill the whole conversation
because its prompt cache has expired on idle: the idle time, the context size
and the estimated re-bill, over two doors — send anyway, or summarize and
continue on a small base. Only idle expiry raises it; a break the user just
caused, like a model switch, never does.
_Avoid_: cache warning, expiry popup, stale-cache dialog.

**Overlay region**:
The area every overlay covers: from below the 50px bar row to the bottom of
the window, and from the sidebar's right edge to the window's right edge —
the chat column and the context panel together. The sidebar, the top bar and
the context panel's tab strip are never covered. Boards, the runs views, the
session tree, Settings and the small dialogs all live here.
_Avoid_: modal layer, full-screen overlay, scrim.

**Standing prompt**:
The text appended to every agent Crucible starts, whatever its role prompt
says — things true of every agent regardless of its job. Day one it is the
communication style block, nothing else.
_Avoid_: global prompt, append slot, junk drawer.

**Interrupted**:
The status of a run that Crucible quit out from under: its progress stopped
where it stood, its worktree and artifacts are intact, and it can be resumed.
Distinct from failed, which means the work itself went wrong.
_Avoid_: stale, crashed, orphaned, failed (for this case).

**Resume**:
Restarting an interrupted run by re-running the node the quit cut down, from
that node's beginning, in the same worktree, reporting to the same
orchestrator. Always a deliberate act — the human's click or an agent's tool
call — never the system's own.
_Avoid_: auto-resume, restart (that is the whole run), retry.

**Instance badge**:
The top-bar mark naming which state directory a dev window is running
against — "dev" for the primary clone, "dev · <suffix>" for a worktree
launch. The installed app shows none: the badge marks the exceptional case.
_Avoid_: flavor chip, dev pill, environment indicator.
