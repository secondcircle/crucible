# Alignment — Working Ember chat shell, fresh start on the new build process

**Intent brief · output of `/align` · 2026-08-19**

## What we're building

The first dogfood-ready Crucible surface: a minimal interactive chat shell in
Ember's visual language, built from `docs/design/mock-a-ember.html`. It
includes real workspace and curated-session management, concurrent sessions,
a searchable model picker, native thinking controls, stock π agent behavior,
formatted assistant responses, real tool/thinking/usage events, and
immediate Stop/Escape cancellation. Everything visible is backed by genuine
app state or an agent-port value/event; the fake adapter stays the
deterministic zero-cost default and labels itself honestly.

This brief supersedes `.crucible/align/260818-working-chat-shell.md`. That
interview's 28 rulings are adopted verbatim below; what changed is the
process and the references, not the product. The old 19-slice chained-run
build was judged over-engineered and its work was deleted: the repository is
back to `main` (the walking skeleton), every other branch and worktree is
gone, and this brief is written to be the intent input of a single `build`
workflow run, followed by `merge-gate`. Whether and when those runs happen
is the human's call.

One firewall stated plainly: **this shell contains no workflow-system
features whatsoever** — no runs, no staging, no dashboards, no workflow
vocabulary in the UI. Crucible's workflow engine is future work, and nothing
in this brief concerns it.

## Rulings — what the user settled (this interview, 2026-08-19)

- **Q1 Canonical Ember reference:** Mock A is the Ember the user wants. The
  recovered prototype set was verified by the user; all non-cited mocks
  (b-ledger, c-forge, e-detach) and `feature-inventory.md` are deleted.
- **Q2 The prior brief holds:** The 2026-08-18 brief is correct and is the
  one the user remembers making. Its scope and all 28 rulings carry forward
  wholesale; this interview settles only the deltas (references, leftover
  branches, process wording).
- **Q3 Old build output deleted:** The `crucible/build-260818-la43` branch
  (slices 2–6 of the old ladder) is deleted, not merged or salvaged. "We're
  going to start over. That was a completely over-engineered build process,
  and that's what we're trying to fix." The builder starts from `main`.
- **Q4 Cited design references survive:** mock-d (picker interaction),
  mock-f (resume flow), mock-g (tool/thinking/detail patterns), and
  `m1-parity-core.md` (feature ordering and later-feature boundaries) are
  kept because the adopted rulings cite them. The uncited
  `feature-inventory.md` is deleted.
- **Q5 References live in the repo:** The five keepers are copied to
  `docs/design/` and this brief cites those paths. The /tmp originals were
  lost once to a temp wipe and recovered from a π session transcript; that
  does not happen twice.
- **Q6 Deferral wording and scope firewall:** (a) The old brief's "left to
  the seam gate" deferral is reworded: the exact agent-port operation,
  snapshot, identity, and event shapes are deferred to the build run's own
  design step. The old seam-gate process step no longer exists; the deferral
  itself is unchanged. (b) The user wants a blanket statement that nothing
  in this work has anything to do with workflows — the shell ships no
  workflow-system features; workflows are eventual, separate work.
- **Q7 Fresh start, main only:** Every branch that is not `main` is deleted,
  along with all worktrees. Run records under `.crucible/runs/` remain as
  history.

## Adopted rulings — carried verbatim from the 2026-08-18 interview (per Q2)

- **A1 Which prototype regions ship:** The center-column-only recommendation
  was rejected. The dogfooding floor includes the workspace/sidebar,
  sessions, top bar, chat transcript, composer, model picker, and thinking
  control.
- **A2 Composer controls and agent identity:** Ship genuine model and
  thinking controls rather than hard-coded labels. Do not ship the
  attachment control yet, and do not fabricate an agent/model byline.
- **A3 Agent-port cancellation:** Cancellation must be a real agent-port
  capability with a distinct cancelled terminal outcome, targeted so a stale
  cancellation cannot affect later work. The exact multiplexed operation and
  event shapes are for the build run's design step (per Q6), not the UI to
  fake.
- **A4 Cancellation result:** Stop aborts current work immediately without
  disposing the session. Partial output remains visible with a quiet stopped
  marker, and the user can redirect with another prompt.
- **A5 Keyboard behavior:** Enter sends, Shift+Enter inserts a newline, and
  Escape stops work in the active session. Escape with no active work does
  nothing.
- **A6 Markdown and code rendering:** Assistant responses render formatted
  markdown, including lists, tables, inline code, and fenced code blocks.
  User messages remain plain text. Raw HTML does not execute; links must not
  navigate the Crucible window. Syntax highlighting is not required.
- **A7 Tool and thinking regions:** Both ship, driven by real port events,
  never static UI. Thinking is dim and collapsible; tool calls expose real
  running/completed state and expandable output in the Ember pattern.
- **A8 Styling structure:** Preserve the prototype's Ember palette,
  typography, spacing, and component language through shared theme tokens
  and maintainable component-specific CSS. The exact standard React CSS
  mechanism is delegated downstream.
- **A9 Window chrome:** The window has the Ember background from first paint
  (no white flash). Keep the standard title bar until later shell work
  provides a sound drag region.
- **A10 Live transcript behavior:** Auto-scroll while the user remains at
  the bottom, never pull them back after they scroll up, show genuine
  elapsed working time, and provide a minimal Ember empty state without
  fabricated suggestions.
- **A11 Proof of completion:** Cover markdown and cancellation in component
  tests, cancellation and stale-target behavior below the renderer, and
  manually drive the fake app with Agent Browser to render code and stop a
  live turn. No paid SDK proof was authorized by either interview.
- **A12 Session, thread, and reset:** Use **Session**, never thread, for a
  curated sidebar item holding one conversation. New Session adds another
  item. Session Reset keeps the sidebar identity but replaces its
  conversation with a fresh stock π session.
- **A13 Workspace lifecycle:** Add Workspace opens an OS folder picker.
  Workspaces can be added, switched, removed from Crucible without deleting
  their folders, remembered across launches, and restored to the last active
  workspace.
- **A14 Model source and default:** No hard-coded SDK model. Populate the
  picker from models genuinely available through the user's existing
  credentials and custom model configuration. Resume restores that session's
  model; a new session uses Crucible's last selection, with the SDK's
  available fallback only when needed.
- **A15 Stock tools and event-backed chips:** Run the agent in the workspace
  with π's stock coding tools. Tool and thinking displays consume real
  adapter events; the fake adapter may emit deterministic events as its
  truthful implementation, but the renderer never invents them.
- **A16 Final Ember region cut:** Ship the full left sidebar, real top bar,
  transcript, and composer. The top bar shows real workspace, session
  placeholder, model/working state, and real context usage. The right-side
  Context edge and pane remain absent.
- **A17 Meaning of stock π:** Use π's built-in tools and system prompt,
  persistent sessions, workspace context files and skills, and the user's
  credentials/custom models. Do not load extensions or packages from the
  legacy system; it remains a read-only reference with no runtime
  dependency.
- **A18 Concurrent sessions:** Sessions may work concurrently. Switching
  sessions does not stop the one left behind, each session has independent
  working state, and Stop/Escape affects only the active session. This
  supersedes the boilerplate's app-global single-flight assumption.
- **A19 New and Reset placement:** Keep New Session prominent in the
  sidebar. Put Reset Session in the active session's header menu and confirm
  it when the session is non-empty. No `/new`; the capability must have a
  visible GUI affordance.
- **A20 Curated sidebar membership:** The sidebar is Crucible-owned curated
  state, not a projection of adapter-managed history. It contains only
  sessions the user creates or explicitly resumes in Crucible, and those
  choices persist across launches.
- **A21 First model-picker scope:** Ship a searchable picker and
  current-model chip. Favorites and model-cycling shortcuts are deferred.
  Selection belongs to the session and restores with it.
- **A22 Native thinking levels:** Expose the native π thinking levels
  supported by the selected model rather than hard-coding low/medium/high.
  The setting belongs to the session, changes between turns, and warns
  before a known cache-invalidating change.
- **A23 Resuming a conversation:** An explicit Resume Session search flow
  scoped to the active workspace. Adapter-managed history is searched only
  when the user opens that flow; choosing a result adds it to the curated
  sidebar and activates it.
- **A24 Removing a session:** Removing a session forgets its Crucible
  sidebar entry only. It does not delete adapter-managed persistence, and
  the conversation may be resumed again later.
- **A25 What survives reset:** Reset detaches the old conversation and binds
  the same sidebar item to a fresh one. The old conversation remains in
  adapter-managed history, findable through Resume Session, without exposing
  its backing representation.
- **A26 Session naming:** No naming or rename UX now. Use a neutral
  placeholder label; session naming is deliberately deferred.
- **A27 Honest fake-flavor data:** The fake adapter exposes an explicitly
  labelled `fake/deterministic` model and coherent scripted usage, thinking,
  tool, streaming, and cancellation behavior. Workspace and curated-session
  state remain genuine app state. Nothing paints model, context, thinking,
  or tool data without a matching port value or event.
- **A28 π storage boundary:** Crucible uses its own session identities and
  operations and never reads, parses, edits, deletes, exposes, or reasons
  about π files. Only the SDK adapter may translate those operations into
  π's public session APIs.

## Constraints and non-negotiables

- This shell ships no workflow-system features: no runs, staging,
  dashboards, or workflow vocabulary anywhere in the UI (Q6b).
- The build starts from `main` as it stands — the walking skeleton. The old
  slice work is deleted, not salvage to consult (Q3).
- The renderer reaches all agent behavior only through the agent port; no π
  SDK type or storage concept crosses that seam (ADR 0001).
- Preserve Ember's visual language from `docs/design/mock-a-ember.html` and
  its supporting mocks; tokens per the mock (background `#191419`, accent
  `#e07a4f`, etc.).
- No inert controls and no model, context, workspace, session-status, tool,
  or thinking data pretending to be real.
- The fake adapter remains the default for development, tests, and
  agent-driven checks; verifying this work costs nothing.
- The SDK adapter runs a stock π agent in the active workspace but must not
  load the legacy system's extensions or packages.
- Sessions are curated (ADR 0002) and concurrent (ADR 0003); adapter history
  never auto-populates the sidebar; π storage stays behind the SDK adapter
  (ADR 0004).
- Stop/Escape is immediate, session-local, and leaves the app ready for a
  redirect.
- Out of scope: the right Context region, attachments, queued
  steering/follow-ups, session tree/branching, model favorites, login UI,
  session naming, permanent deletion, and anything workflow-related.
- No paid SDK proof without separate explicit human authorization under
  `AGENTS.md`.

## Still open

- Exact Crucible-owned agent-port operations, state snapshots, identities,
  and ordered events for workspaces, concurrent sessions, model selection,
  thinking levels/blocks, tools, usage, reset/resume, and cancellation —
  deferred to the build run's design step (Q6a); the user settled the
  experience and delegated interface design.
- Session naming and rename UX — deliberately deferred to a later slice
  (A26).

## Durable residue from this interview

- `CONTEXT.md`: added **Ember** (the shell's visual language). Workspace,
  Session, and Session reset were added by the 2026-08-18 interview and
  stand.
- `docs/adr/`: nothing new; ADRs 0001–0004 stand unchanged.
- `docs/design/`: mock-a-ember.html, mock-d-atrium.html,
  mock-f-sessions.html, mock-g-m1-details.html, m1-parity-core.md —
  recovered from the authoring session transcript, verified by the user,
  now repository files (uncommitted at interview close; they land with this
  brief).

## Source material (read these — do not work from paraphrase)

- `docs/design/mock-a-ember.html` — the canonical Ember visual and region
  reference; the user verified this exact file.
- `docs/design/mock-f-sessions.html` — sidebar and resume interaction
  reference; its auto-population assumptions are superseded by A20.
- `docs/design/mock-d-atrium.html` — searchable model-picker interaction
  reference; use Ember styling, not Atrium styling.
- `docs/design/mock-g-m1-details.html` — Ember tool, thinking, error,
  session-header, and thinking-control patterns.
- `docs/design/m1-parity-core.md` — feature ordering and explicit
  later-feature boundaries; ordering guidance for the builder, not a run
  schedule.
- `CONTEXT.md` — canonical terms: Ember, Workspace, Session, Session reset,
  agent port, fake adapter, SDK adapter.
- `docs/adr/0001` through `docs/adr/0004` — the four standing decisions this
  work must preserve.
- `.crucible/align/260818-working-chat-shell.md` — the superseded prior
  brief; provenance for the adopted rulings. Where it disagrees with this
  file, this file wins.
- `src/shared/agent/port.ts` — current narrow port contract the design step
  must evolve.
- `src/main/agent/channel.ts` — current app-global single-flight authority,
  superseded by A18.
- `src/main/agent/sdk-adapter.ts` — current hard-coded, in-memory, tools-off
  SDK adapter this work replaces.
- `src/renderer/src/ChatPane.tsx` — current walking skeleton and
  component-test seam.
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`
  — public SDK capabilities: runtime replacement, models, thinking, tools,
  events, abort, persistence.
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/sessions.md`
  — native session behavior and terminology; storage stays adapter-internal.
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/session-format.md`
  — SDK-adapter implementation reference only; never a Crucible-owned
  contract.
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md`
  — native model and model-specific thinking-level capabilities.
