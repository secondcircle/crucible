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
An OS folder opened in Crucible as an agent working directory and as the home of that folder's sessions.
_Avoid_: project, repository.

**Session**:
A user-curated workspace sidebar item holding one agent conversation. It appears only when the user creates or adds it in Crucible; adapter-managed history never populates the sidebar by discovery.
_Avoid_: thread, chat, backing-store record.

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

**Intent brief**:
The durable artifact an `/align` interview writes on agreement — the settled
scope and rulings — at `.crucible/align/` in the workspace. The interview
says nothing about what happens to it next.
_Avoid_: alignment doc, spec, plan.

**Context panel**:
The agent-curated display split to the right of the chat area, where a
session's agent shows rendered exhibits — HTML or markdown files — in tabs.
Adopted verbatim from the legacy system, tools and all.
_Avoid_: preview pane, artifact viewer, right sidebar.

**Tab**:
One entry in the context panel: a title over one exhibit file, keyed by path
so re-showing the same file refreshes it in place. Per-session, like the
panel itself.
_Avoid_: pane, exhibit slot, window.

**Branch board**:
The workspace-scoped view of every branch the user owns in that repository,
grouped by whether the work has landed, and of the host pull requests that
name the user. It reports; it never deletes or checks out anything.
_Avoid_: git panel, branch manager, PR dashboard.

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
a full override; π's stock prompt is never used. One role exists today: the
interactive coding agent.
_Avoid_: system prompt (the composed whole), base prompt.

**Standing prompt**:
The text appended to every agent Crucible starts, whatever its role prompt
says — things true of every agent regardless of its job. Day one it is the
communication style block, nothing else.
_Avoid_: global prompt, append slot, junk drawer.
