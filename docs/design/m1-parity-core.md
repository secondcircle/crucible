# Milestone map — "bone-stock π, better skin"

The cut: everything you need to abandon the TUI for daily basic work, nothing
else. Think π at first ship. (This is the *feature* milestone that follows the
boilerplate run; each block below is roughly one align + build.)

## In — parity core

**Workspaces & sessions**
- Add workspace (OS folder picker) · switch active workspace
- New session in active workspace (⌘N)
- Resume: recent sessions inline in sidebar, ⌘O search overlay (see mock)
- Rename session (inline)
- Sessions auto-save via SDK — plumbing, no UI

**Chat**
- Send · stream · markdown + code rendering
- Tool-call chips, collapsed by default, click to expand
- Thinking blocks, same pattern, dimmer
- Abort: Stop button + esc
- Queue (ruled): send while streaming → ghosted queued bubbles; all deliver
  together ASAP. Esc = abort (queue returns to composer, queue on top,
  draft below). Click the queued stack = unqueue without aborting.
  Double-esc reserved for session tree (M2). No toggles, no queue settings.
- Compaction notice card when it happens (auto-compaction itself is SDK plumbing)

**Models & reasoning**
- Model picker: click the composer chip → searchable popover, star favorites
- ⌘P cycles starred models
- Thinking level chip cycles low/med/high

**Auth**
- Login / logout per provider (Anthropic, OpenAI…) — settings-style dialog;
  model picker reflects what the current credentials can reach

**Instrumentation**
- Context meter (in Ember top bar)
- Per-session cost, live (shown in resume overlay + session header)
- Cache health, first-class (ruled): persistent header badge on any miss,
  inline transcript seam at the breaking turn, guard dialog before
  cache-invalidating actions (e.g. thinking-level change mid-session)

**Principles (ruled)**
- Everything fails loudly — no hidden errors, ever; errors are cards in the
  transcript, never toasts
- Workspaces are auto-trusted at creation — no trust dialog

## Out — explicitly M2+

- Session tree / double-esc, fork, clone *(first M2 candidate — design it early, build it after parity)*
- @ file mentions, image paste, drag-drop attachments
- Export / import / share
- Prompt templates, skills UI, themes, settings window (beyond login + what the chips cover)
- `!bash` composer commands — ruled back in (2026-08-19 align); mechanism designed there
- Slash commands — typed prefixes are legitimate paths; whether a capability
  also gets a GUI control is ruled case by case in its own align, never by
  blanket principle (re-ruled 2026-08-20; the earlier "every capability gets a
  GUI affordance" rule bred invented controls and is dead)
- Detach windows (pattern agreed, built when the context/workflow regions arrive)
- Workflow surface, context pane — Crucible-specific, own track, not π parity

## Sequencing sketch

1. Boilerplate (running now) — walking skeleton
2. Chat shell — Ember layout, markdown, tool chips, abort *(reference: mock A v2)*
3. Sessions & workspaces *(reference: mock F)*
4. Models + thinking + auth
5. Queue semantics (steer/follow-up) + instrumentation + trust
→ then: session tree (M2 headliner), context pane, workflow surface
