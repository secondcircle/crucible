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
| /model | model selector (Ctrl+L) | **built** — searchable popover on the composer chip, populated from real credentials/config, never hard-coded (A14, A21); model aliases rename ids Crucible knows by heart for display on the chip and never change what the picker lists |
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
| /tree · double-esc | jump to any point, branch, continue; labels, search, filters | **built** — full overlay over the transcript (Mock I): ⑂ Tree button and double-Esc, user messages as nodes with a dim activity line between them, type-to-search, free-text labels, and two continue actions (plain jump, jump with summary). Jumps are in place. Filters and fold/unfold are still later |
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
| @ file search | fuzzy-search project files | **built** — popover over the workspace service's file list, gitignore-aware; picking a result inserts the workspace-relative path as plain text, and nothing is attached |
| Image paste / drag | Ctrl+V, drag onto terminal | **built** — ⌘V and a full-window drop veil, thumbnail chips with a remove ×, png/jpeg/gif/webp up to 10 MB each, thumbnails on the sent message. No file-picker button yet; queued messages still carry text only |
| ! bash commands | !cmd sends output to LLM, !!cmd doesn't | **built, diverged from π** — one grammar: any number of leading `!` runs locally, output lands in a dismissible drawer, and **Add to conversation** is the only way the model ever sees it. π's decide-upfront `!`/`!!` split is gone |
| External editor | Ctrl+G opens $EDITOR | never — the composer is the editor |
| Prompt templates | /templatename expands | **built as Crucible commands, diverged from π** — `/name args` over Crucible's own folders (`~/.crucible/commands/`, `<workspace>/.crucible/commands/`, built-ins shipped with the app), expanded by a main-process command service before anything crosses the port (ADR 0007). π's semantics copied, π's `.pi/prompts` folders ignored entirely |

## 6 · Extensibility & config

| π feature | π behavior | Crucible status |
|---|---|---|
| Skills | /skill:name | not loaded — the SDK adapter reads no skills at all, in Crucible's agent dir or the workspace (ADR 0012); a Crucible-owned skill story is a later /align |
| Extensions | TUI extension API | never — not portable; legacy-system extensions are explicitly not loaded (A17); Crucible features replace them natively |
| Themes | /settings themes | later — Ember is the theme |
| Settings | /settings UI + settings.json | **built** — gear in the top bar opens a modal sheet with two tabs, Providers and Usage; delivery pacing stays deferred. No settings file: the sheet's own state is per window and nothing about it is persisted |
| Login / logout | provider auth | **built** — Providers tab lists every credentialed provider with its status, an Add provider picker covers the rest of π's catalog, and Crucible renders π's login flow (browser OAuth with a paste fallback, API-key entry). π owns the flow, the token exchange and the storage |
| Agent-facing docs | AGENTS.md, skills | **built** — Crucible ships its agent docs inside the app behind an index (ADR 0006); the role prompt names the index and the agent reads a doc when asked, so no doc text rides the prompt (ADR 0012) |

## 7 · Instrumentation

| π feature | π behavior | Crucible status |
|---|---|---|
| Context meter | footer context % | **built** — top-bar meter, shows a dash until the adapter reports real usage (A16, honest-data rule) |
| Token/cost footer | ↑↓ tokens, cache, cost | **built, in part** — a cost-only chip beside the context meter, dashed until the adapter reports real cost, and a full input/output/cache breakdown in the Usage tab. The cache-health badge and the transcript seam are still later (M1 block 5) |
| Usage history | `pi usage` | **built for the workspace** — Usage tab sums π's per-message usage for the active session and for every curated session of the workspace. No all-time or cross-workspace ledger, and nothing about usage is persisted |

## Principles that shaped the statuses

- Everything visible is backed by real state or a port event; the fake
  adapter labels itself `fake/deterministic` (A27).
- Typed prefixes (slash commands, `@`, `!`) are legitimate paths on their
  own. A GUI control for a capability exists only where an align ruling and a
  mock say so, case by case — never by blanket principle (re-ruled
  2026-08-20; the earlier "every capability gets a mouse/dictation
  affordance" rule was taken literally and bred unasked-for UI).
- The sidebar is curated, never a projection of adapter history (A20).
- π storage never crosses the agent port (A28, ADR 0004).
- The shell ships no workflow-system features (Q6b firewall).
