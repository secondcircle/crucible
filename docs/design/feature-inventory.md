# Crucible feature inventory — π native functionality

Status map, built from π's README/docs. For each: what π does in the TUI,
and where Crucible stands. Originally a pre-align triage sheet; updated
2026-08-19 to match the Ember shell as built.

**built** means implemented on `crucible/ember-shell` (gate-approved, not yet
merged to `main`). **later** means ruled in but not started; the parenthetical
names the milestone from `m1-parity-core.md`. **never** means ruled out.

## 1 · Chat core

| π feature | π behavior | Crucible status |
|---|---|---|
| Send / stream | Enter sends, response streams | **built** — Enter sends, Shift+Enter newline (A5) |
| Steering messages | Enter while agent works → queued, delivered mid-work | later (M1 block 5) — ghosted queued bubbles, semantics ruled in m1-parity-core |
| Follow-up queue | Alt+Enter → delivered after all work | later (M1 block 5) — merged with steering into one queue ruling |
| Abort | Esc aborts, restores queue to editor | **built** — Stop button + Esc, immediate, session-local, partial output kept with a quiet stopped marker (A4, A18) |
| Tool-call display | collapsible tool output (Ctrl+O) | **built** — collapsed chips, click to expand, real running/completed state from port events (A7, A15) |
| Thinking blocks | collapsible (Ctrl+T) | **built** — one dim non-collapsible element; no header, no toggle, no duration. A7 originally said "dim and collapsible"; amended 2026-08-19 by the user in /align: non-collapsible is the ruling, not a divergence |
| Markdown render | terminal markdown | **built** — in-house renderer: lists, tables, inline + fenced code; raw HTML inert, links never navigate the window; no syntax highlighting (A6 said not required) |
| Elapsed working time | footer timer | **built** — composer ticks seconds while a turn runs (A10) |
| Auto-scroll | follows output | **built** — pins to bottom via ResizeObserver, never yanks the reader back up (A10) |

## 2 · Models & reasoning

| π feature | π behavior | Crucible status |
|---|---|---|
| /model | model selector (Ctrl+L) | **built** — searchable popover on the composer chip, populated from real credentials/config, never hard-coded (A14, A21) |
| Scoped models + cycling | /scoped-models, Ctrl+P cycles | later (M1 block 4) — favorites + ⌘P cycling explicitly deferred by A21 |
| Thinking level | Shift+Tab cycles; editor border shows level | **built** — composer chip lists the *native* levels the selected model supports (A22), per-session, changes between turns only |
| Cache guard | (none in TUI) | **built** — "Invalidate this session's cache?" dialog before a mid-conversation thinking change (A22; ruled first-class in m1-parity-core) |

## 3 · Sessions

| π feature | π behavior | Crucible status |
|---|---|---|
| /new | new session | **built** — New session button in sidebar (A19) |
| /resume | pick from past sessions | **built** — explicit Resume search overlay scoped to the active workspace; choosing a result adds it to the curated sidebar (A20, A23) |
| Remove from list | (n/a) | **built** — removing a session forgets the sidebar entry only; adapter history keeps the conversation, resumable later (A24) |
| Session reset | (n/a — TUI /new discards) | **built** — Reset session in the header menu, confirm when non-empty; same sidebar identity, fresh conversation, old one stays findable via Resume (A12, A19, A25) |
| /name | rename session | later — deliberately deferred, neutral placeholder label for now (A26) |
| /session info | file, ID, tokens, cost | partial — context meter is in the top bar; per-session cost display not built (M1 block 5 instrumentation) |
| /tree · double-esc | jump to any point, branch, continue; labels, search, filters | later (M2 headliner) — **the big one.** Nothing in GUI-chat-land to copy; design it early, build it after parity |
| /fork | new session from a previous user message | later (M2) — action in the tree view: "fork from here" |
| /clone | duplicate active branch to new session | later (M2) — session context menu |
| /compact | manual + auto compaction | partial — auto-compaction is SDK plumbing and works; the notice card in the transcript is not built (M1) |
| /export /share | HTML/JSONL export, gist share | later (M2+) |
| /import | resume from JSONL | later (M2+) |

## 4 · Workspaces

(π has no workspace concept beyond cwd; this section is Crucible-native.)

| capability | Crucible status |
|---|---|
| Add workspace | **built** — OS folder picker (A13) |
| Switch / remove / persist | **built** — remove forgets, never deletes the folder; last active workspace restored across launches (A13) |
| Trust | ruled — workspaces are auto-trusted at creation, no dialog (m1-parity principle); π's /trust prompt has no Crucible equivalent |

## 5 · Composer / input

| π feature | π behavior | Crucible status |
|---|---|---|
| @ file search | fuzzy-search project files | later (M2+) |
| Image paste / drag | Ctrl+V, drag onto terminal | later (M2+) — attachment control deliberately absent (A2) |
| ! bash commands | !cmd sends output to LLM, !!cmd doesn't | ruled back in (2026-08-19) — the "TUI-ism" call was an over-interpretation; the need is real, mechanism in design |
| External editor | Ctrl+G opens $EDITOR | never — the composer is the editor |
| Prompt templates | /templatename expands | later (M2+) |

## 6 · Extensibility & config

| π feature | π behavior | Crucible status |
|---|---|---|
| Skills | /skill:name | agent-side works now — stock π loads workspace skills through the SDK adapter (A17); UI exposure later |
| Extensions | TUI extension API | never — not portable; legacy-system extensions are explicitly not loaded (A17); Crucible features replace them natively |
| Themes | /settings themes | later — Ember is the theme |
| Settings | /settings UI + settings.json | later — settings window eventually; today the chips cover it |
| Login / logout | provider auth | later (M1 block 4) — today the picker reflects whatever the user's existing credentials reach (A14) |

## 7 · Instrumentation

| π feature | π behavior | Crucible status |
|---|---|---|
| Context meter | footer context % | **built** — top-bar meter, shows a dash until the adapter reports real usage (A16, honest-data rule) |
| Token/cost footer | ↑↓ tokens, cache, cost | later (M1 block 5) — per-session live cost, plus cache-health badge and transcript seam, all ruled in m1-parity-core |
| Usage history | `pi usage` | later (M2+) — a workspace-level view |

## Principles that shaped the statuses

- Everything visible is backed by real state or a port event; the fake
  adapter labels itself `fake/deterministic` (A27).
- Every capability has a GUI affordance that works with mouse or dictation;
  typed shortcuts (slash commands, composer prefixes) may exist as
  accelerators but are never the only path (re-ruled 2026-08-19 — the earlier
  "no slash commands, ever" was an over-interpretation).
- The sidebar is curated, never a projection of adapter history (A20).
- π storage never crosses the agent port (A28, ADR 0004).
- The shell ships no workflow-system features (Q6b firewall).
