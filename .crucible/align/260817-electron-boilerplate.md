# Alignment — Crucible Electron app boilerplate with a testable agent port

**Intent brief · output of `/align` · 2026-08-17**

## What we're building

Crucible is getting a dedicated surface: an Electron desktop app powered by
the π SDK (not the TUI). The legacy system — the TUI-based π extension
workspace at `../pi-extensions` — stays as a read-only reference; pieces of
it will be rebuilt here one at a time, later. This run builds none of them.

This run builds the boilerplate: an electron-vite + React + TypeScript app
whose defining property is testability, especially of the UI. The renderer
never touches the π SDK; it talks only to a Crucible-owned **agent port**
(prompt in, event stream out), implemented by a **fake adapter** (canned
responses, the dev/test default — zero API cost) and a minimal **SDK
adapter** (chat only: send prompt, stream text back — the thinnest tracer
bullet through the whole stack, proven against the real SDK once). A
walking-skeleton chat pane renders a streamed reply, unstyled. Logging is
built so that an agent can diagnose a problem the human describes purely
from the log file.

Definition of done (Q8 as amended by Q16):

1. `npm run dev` opens the app with HMR; renderer sandboxed
   (contextIsolation on, nodeIntegration off).
2. Agent port defined; fake adapter is the dev default; minimal SDK adapter
   proven against the real SDK once.
3. Walking-skeleton chat pane: type a message, response streams and renders.
   Unstyled.
4. Unit tests (main-process logic, adapters) and component tests (chat pane
   against the fake adapter) — at least one meaningful test per layer, all
   green.
5. An agent in this repo can verify manually: launch the app, drive it with
   Agent Browser, send "Hello agent", see the canned reply rendered, at zero
   API cost.
6. Structured JSONL logging to a known repo-local, gitignored location (e.g.
   `logs/`): main-process lifecycle, every agent-port call and event (which
   adapter, prompt, stream events, errors), IPC failures, and renderer
   errors/console forwarded into the same single chronological stream — with
   one meaningful test that the forwarding works.
7. Lint, typecheck, and test scripts wired.

## Rulings — what the human settled

- **Q1 Scope of this align:** Boilerplate milestone only — "setting up a
  boilerplate environment with best practices in place that let us get to
  where we're talking about getting to." Each later feature (model picker,
  login, session UX, chat design) gets its own align.
- **Q2 What "Crucible" names:** The entire app — a personal development
  system built on top of π. It began as π extensions, grew into the workflow
  engine (the real thing being built), and now gets a dedicated app for a
  better user experience.
- **Q3 Stack:** electron-vite + React + TypeScript.
- **Q4 SDK placement:** π SDK in the Electron main process behind typed IPC,
  renderer sandboxed. *Synthesized, not heard:* the human accepted this
  recommendation explicitly deferring to it ("I don't even know what the
  trade-offs are"), so treat the process model as proposed-and-accepted, not
  a considered human ruling — cheap to revisit if reality objects.
- **Q5 Mock boundary:** A Crucible-owned agent port with adapters — not
  mocks of π SDK types. The human's added reason: it hedges against dropping
  the π SDK entirely someday, and "having that adapter between the UI/UX
  layer and basically everything else is going to make that whole process so
  much easier to test with."
- **Q6 Test layers:** Unit and component tests only — "anything that's very
  fast." No browser E2E suite ("complete overkill"). The binding requirement
  instead: an agent working in this repo must be able to launch the app,
  drive it with Agent Browser, send a chat message, and confirm the response
  renders correctly — without any request that costs money. Agents should be
  able to manually verify the app the way a developer would: start it and
  play in it.
- **Q7 Prototyping:** In-app, live, after the boilerplate — electron-vite's
  HMR makes iteration feel like a normal React dev server. When the human is
  the one prototyping with the agent, using the actual SDK is fine.
- **Q8 Definition of done:** The seven-point list above, accepted as
  written and amended by Q16.
- **Q9 Carry-over:** Nothing copied from the legacy repo — no file lands in
  this repo unless it was discussed and decided here. (Supersedes the
  original question of importing `PRINCIPLES.md`.)
- **Q10 Dogfooding:** Yes — build this milestone through the legacy Crucible
  steer/build workflow. The workflow's missing prototyping stage is a known
  gap, out of scope here (see Still open).
- **Q11/Q14 Adapters in milestone 1:** Both. Fake adapter as default; the
  SDK adapter included because, minimal as chat-only, it is "the single
  thinnest tracer bullet through the whole stack, so it's probably worth
  doing."
- **Q12 Login/logout:** Deferred to its own align. The SDK adapter relies on
  credentials already on disk from TUI use. The app must eventually support
  login/logout like the π TUI — flag planted.
- **Q13 Residue:** Standard `/align` residue (`CONTEXT.md`, `docs/adr/`)
  welcome in this repo. Also ruled: `AGENTS.md` must point agents at both
  (done).
- **Q15 ADR:** Agent-port decision recorded as ADR 0001.
- **Q16 Logging:** Accepted — agent-legible, file-based, one merged
  chronological JSONL stream across main and renderer. The bar: "if I
  describe an issue, the agent should be able to look at the logs and tell
  what the issue is... otherwise, our logging isn't good enough."

## Constraints and non-negotiables

- The renderer never imports the π SDK or its types; the agent port is the
  only path (ADR 0001).
- Agents must never need a paid API call to verify the app; the fake adapter
  is the default everywhere agents operate.
- Use `CONTEXT.md`'s terms exactly: agent port, fake adapter, SDK adapter,
  legacy system.
- Nothing from the legacy repo is copied in; it is reference only.
- No packaging/auto-update, no CI, no styling/design work, no browser E2E
  suite, no login UI, no legacy feature migration in this run.

## Still open

- Where human-in-the-loop UI prototyping slots into the Crucible workflow —
  everything past PRD/design is currently human-out-of-the-loop; the human
  called this an oversight. A legacy-repo align, deliberately not solved
  here.
- The feature checklist: which π TUI features (model picker, etc.) to
  replicate and their UX — one align per feature, after the boilerplate.
- Login/logout UX (Q12) and session management UX — new/old sessions are
  "built into π and we're just going to have to give a new coat of paint to
  it." Flags planted, own aligns.
- Whether one aligned document or per-feature aligns govern the UX work —
  the human leaned per-feature (Q1) but expects prototyping to be
  back-and-forth; revisit when the first feature align starts.

## Durable residue from this interview

- `CONTEXT.md`: created — **Crucible**, **legacy system**, **agent port**,
  **fake adapter**, **SDK adapter**.
- `docs/adr/0001-ui-reaches-agents-only-through-the-agent-port.md`: the UI
  reaches agents only through the agent port.
- `AGENTS.md`: created — high-level statement of the migration and pointers
  to `CONTEXT.md` and `docs/adr/`.

## Source material (read these — do not work from paraphrase)

- `/Users/ike/repos/crucible/CONTEXT.md` — this repo's glossary; use its
  words exactly.
- `/Users/ike/repos/crucible/docs/adr/0001-ui-reaches-agents-only-through-the-agent-port.md`
  — the port decision and the rejected alternative.
- `/Users/ike/repos/crucible/AGENTS.md` — the standing frame for agents in
  this repo.
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`
  — the π SDK surface the SDK adapter wraps (`createAgentSession`,
  `AgentSession.prompt/subscribe`, event stream shape).
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/sdk/`
  — working SDK examples, minimal to full control.
- `/Users/ike/repos/pi-extensions/` — the legacy system. Reference only;
  copy nothing.
