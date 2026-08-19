# Alignment — Working Ember chat shell for first dogfooding

**Intent brief · output of `/align` · 2026-08-18**

## What we're building

Build the first dogfood-ready Crucible surface from `/tmp/crucible-proto/mock-a-ember.html`, preserving Ember’s visual language. This is more than a styled chat pane: it includes real workspace and curated-session management, concurrent session work, a searchable model picker, native thinking controls, stock π agent behavior, formatted assistant responses, real tool/thinking/usage events, and immediate Stop/Escape cancellation.

A workspace is an OS folder and the agent runs there with stock π behavior. Its sidebar contains only sessions the user deliberately creates or resumes in Crucible—not every conversation the adapter can discover. Sessions may keep working in the background while the user works in another session. The SDK adapter may use π’s public APIs internally, but no Crucible-owned interface or UI knows or manipulates π’s persistence format.

Everything visible must be backed by genuine app state or an agent-port value/event. The fake adapter remains the deterministic, zero-cost development and test implementation and labels its model and usage honestly as fake. The SDK adapter supplies real models, thinking, tools, usage, persistence, and cancellation.

## Rulings — what the human settled

- **Q1 Which prototype regions ship:** The initial center-column-only recommendation was rejected. The dogfooding floor includes the workspace/sidebar, sessions, top bar, chat transcript, composer, model picker, and thinking control.
- **Q2 Composer controls and agent identity:** Ship genuine model and thinking controls rather than hard-coded labels. Do not ship the attachment control yet, and do not fabricate an agent/model byline.
- **Q3 Agent-port cancellation:** Cancellation must be a real agent-port capability with a distinct cancelled terminal outcome, targeted so a stale cancellation cannot affect later work. The exact multiplexed operation and event shapes are for the seam design, not the UI to fake.
- **Q4 Cancellation result:** Stop aborts current work immediately without disposing the session. Partial output remains visible with a quiet stopped marker, and the user can redirect with another prompt.
- **Q5 Keyboard behavior:** Enter sends, Shift+Enter inserts a newline, and Escape stops work in the active session. Escape with no active work does nothing.
- **Q6 Markdown and code rendering:** Assistant responses render formatted markdown in the transcript, including lists, tables, inline code, and fenced code blocks. User messages remain plain text. Raw HTML does not execute; links must not navigate the Crucible window. Syntax highlighting is not required in this slice.
- **Q7 Tool and thinking regions:** Both belong in this slice. They must be driven by real port events, not static UI. Thinking is dim and collapsible; tool calls expose real running/completed state and expandable output in the Ember pattern.
- **Q8 Styling structure:** Preserve the prototype’s Ember palette, typography, spacing, and component language through shared theme tokens and maintainable component-specific CSS. The exact standard React CSS mechanism is delegated downstream.
- **Q9 Window chrome:** Give the window the Ember background from first paint to avoid a white flash. Keep the standard title bar until later shell work provides a sound drag region.
- **Q10 Live transcript behavior:** Auto-scroll while the user remains at the bottom, do not pull them back after they scroll up, show genuine elapsed working time, and provide a minimal Ember empty state without fabricated suggestions.
- **Q11 Proof of completion:** Cover markdown and cancellation in component tests, cancellation and stale-target behavior below the renderer, and manually drive the fake app with Agent Browser to render code and stop a live turn. No paid SDK proof was authorized by this interview.
- **Q12 Session, thread, and reset:** Use **Session**, never thread, for a curated sidebar item holding one conversation. New Session adds another item. Session Reset keeps the current sidebar identity but replaces its conversation with a fresh stock π session.
- **Q13 Workspace lifecycle:** Add Workspace opens an OS folder picker. Workspaces can be added, switched, removed from Crucible without deleting their folders, remembered across launches, and restored to the last active workspace.
- **Q14 Model source and default:** Remove the hard-coded SDK model. Populate the picker from models genuinely available through the user’s existing credentials and custom model configuration. Resume restores that session’s model; a new session uses Crucible’s last selection, with the SDK’s available fallback only when needed.
- **Q15 Stock tools and event-backed chips:** Run the agent in the workspace with π’s stock coding tools. Tool and thinking displays consume real adapter events; the fake adapter may emit deterministic events as its truthful implementation, but the renderer never invents them.
- **Q16 Final Ember region cut:** Ship the full left sidebar, real top bar, transcript, and composer. The top bar shows real workspace, session placeholder, model/working state, and real context usage. The right-side Context edge and pane remain absent.
- **Q17 Meaning of stock π:** Use π’s built-in tools and system prompt, persistent sessions, workspace context files and skills, and the user’s credentials/custom models. Do not load extensions or packages from the legacy system; it remains a read-only reference with no runtime dependency.
- **Q18 Concurrent sessions:** Sessions may work concurrently. Switching sessions does not stop the one left behind, each session has independent working state, and Stop/Escape affects only the active session. This supersedes the boilerplate’s app-global single-flight assumption.
- **Q19 New and Reset placement:** Keep New Session prominent in the sidebar. Put Reset Session in the active session’s header menu and confirm it when the session is non-empty. Do not add `/new`; the capability must have a visible GUI affordance.
- **Q20 Curated sidebar membership:** The sidebar is Crucible-owned curated state, not a projection of adapter-managed history. It contains only sessions the user creates or explicitly resumes in Crucible, and those choices persist across launches.
- **Q21 First model-picker scope:** Ship a searchable picker and current-model chip. Favorites and model-cycling shortcuts are deferred. Selection belongs to the session and restores with it.
- **Q22 Native thinking levels:** Expose the native π thinking levels supported by the selected model rather than hard-coding low/medium/high. The setting belongs to the session, changes between turns, and warns before a known cache-invalidating change.
- **Q23 Resuming a conversation:** Provide an explicit Resume Session search flow scoped to the active workspace. Adapter-managed history is searched only when the user opens that flow; choosing a result adds it to the curated sidebar and activates it.
- **Q24 Removing a session:** Removing a session forgets its Crucible sidebar entry only. It does not ask Crucible to delete adapter-managed persistence, and the conversation may be resumed again later.
- **Q25 What survives reset:** Reset detaches the old conversation and binds the same sidebar item to a fresh one. The old conversation remains in adapter-managed history and can be found later through Resume Session, without exposing its backing representation.
- **Q26 Session naming:** Do not design naming or rename UX now. Use a neutral placeholder label for this slice; session naming is deliberately deferred.
- **Q27 Honest fake-flavor data:** The fake adapter exposes an explicitly labelled `fake/deterministic` model and coherent scripted usage, thinking, tool, streaming, and cancellation behavior. Workspace and curated-session state remain genuine app state. Nothing paints model, context, thinking, or tool data without a matching port value or event.
- **Q28 π storage boundary:** Crucible uses its own session identities and operations and never reads, parses, edits, deletes, exposes, or reasons about π files. Only the SDK adapter may translate those operations into π’s public session APIs; forbidding that adapter translation would make native persistence and resume impossible.

## Constraints and non-negotiables

- The renderer reaches all agent behavior only through the agent port; no π SDK type or storage concept crosses that seam.
- Preserve Ember’s visual language from mock A and its supporting session/model/detail prototypes.
- No inert controls and no model, context, workspace, session-status, tool, or thinking data pretending to be real.
- The fake adapter remains the default for development, tests, and agent-driven checks; no paid request is needed to verify this slice.
- The SDK adapter runs a stock π agent in the active workspace but must not load the legacy system’s extensions or packages.
- Sessions are curated and concurrent; persisted adapter history never auto-populates the sidebar.
- Stop/Escape is immediate, session-local, and leaves the app ready for a redirect.
- The right Context region, attachments, queued steering/follow-ups, session tree/branching, model favorites, login UI, session naming, and permanent deletion remain out of scope.
- No paid SDK proof may be run without separate explicit human authorization under `AGENTS.md`.

## Still open

- Exact Crucible-owned agent-port operations, state snapshots, identities, and ordered events for workspaces, concurrent sessions, model selection, thinking levels/blocks, tools, usage, reset/resume, and cancellation. These were deliberately left to the seam gate because the human settled the experience and delegated implementation design.
- Session naming and rename UX, deliberately deferred to a later feature slice.

## Durable residue from this interview

- `CONTEXT.md`: added or sharpened **Workspace**, **Session**, and **Session reset**.
- `docs/adr/0002-sidebar-sessions-are-curated.md`: Sidebar sessions are curated.
- `docs/adr/0003-sessions-may-run-concurrently.md`: Sessions may run concurrently.
- `docs/adr/0004-pi-session-storage-stays-behind-the-sdk-adapter.md`: π session storage stays behind the SDK adapter.

## Source material (read these — do not work from paraphrase)

- `/Users/ike/repos/crucible/CONTEXT.md` — canonical project terms, including the workspace/session distinctions settled here.
- `/Users/ike/repos/crucible/docs/adr/0001-ui-reaches-agents-only-through-the-agent-port.md` — existing renderer/agent boundary that this slice must preserve.
- `/Users/ike/repos/crucible/docs/adr/0002-sidebar-sessions-are-curated.md` — curated sidebar state versus adapter-managed history.
- `/Users/ike/repos/crucible/docs/adr/0003-sessions-may-run-concurrently.md` — concurrency and session-local Stop/Escape.
- `/Users/ike/repos/crucible/docs/adr/0004-pi-session-storage-stays-behind-the-sdk-adapter.md` — storage-format boundary.
- `/tmp/crucible-proto/mock-a-ember.html` — primary visual and region reference.
- `/tmp/crucible-proto/mock-f-sessions.html` — sidebar and resume interaction reference; its auto-population assumptions are superseded by Q20.
- `/tmp/crucible-proto/mock-d-atrium.html` — searchable model-picker interaction reference; use Ember styling, not Atrium styling.
- `/tmp/crucible-proto/mock-g-m1-details.html` — Ember tool, thinking, error, session-header, and thinking-control patterns.
- `/tmp/crucible-proto/m1-parity-core.md` — milestone ordering and explicit later-feature boundaries, as amended by this brief.
- `/Users/ike/repos/crucible/src/shared/agent/port.ts` — current narrow port contract that the seam design must evolve.
- `/Users/ike/repos/crucible/src/main/agent/channel.ts` — current app-global single-flight authority superseded by concurrent sessions.
- `/Users/ike/repos/crucible/src/main/agent/sdk-adapter.ts` — current hard-coded, in-memory, tools-off SDK adapter that this slice replaces.
- `/Users/ike/repos/crucible/src/renderer/src/ChatPane.tsx` — current walking skeleton and component-test seam.
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md` — public SDK capabilities for runtime replacement, models, thinking, tools, events, abort, and persistence.
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/sessions.md` — native session behavior and terminology; storage representation must remain adapter-internal.
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/session-format.md` — implementation reference for the SDK adapter only; never a Crucible-owned contract.
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md` — native model and model-specific thinking-level capabilities.
