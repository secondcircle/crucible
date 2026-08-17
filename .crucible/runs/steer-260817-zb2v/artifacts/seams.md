# Seam sketch — Crucible Electron boilerplate

**Run:** `steer-260817-zb2v` · **Date:** 2026-08-17
**Inputs:** `.crucible/align/260817-electron-boilerplate.md`, `evidence.md`, `CONTEXT.md`, ADR 0001
**Gate:** proposal `seam-proposal.md` reviewed; human answered A1–A4 and left D1–D6 to my recommendations.

Every item below is marked **aligned** (the human addressed it at the gate) or
**proposed** (my synthesis, cheap to reverse). Vocabulary is `CONTEXT.md`'s:
*agent port*, *fake adapter*, *SDK adapter*, *legacy system*.

---

## 1. Where the new behaviour attaches

The repository had no application code, no `package.json`, and no git history
when this run started, so there were no existing seams to prefer. Both seams
below are being created deliberately; the discipline was to create as few as
possible.

### Seam 1 — The agent port (the one behavioural seam)

Everything this milestone can vary — fake vs SDK, in-process vs across the
process boundary, logged vs not — varies at this single interface.

- **Interface:** Crucible-owned TypeScript, shared between main and renderer.
  Prompt in, event stream out. No π SDK type crosses it (ADR 0001).
- **Implementations:**
  - **fake adapter** — canned stream, pure TypeScript, no Electron import, no
    network, no cost;
  - **SDK adapter** — `createAgentSession` → `prompt` / `subscribe`, main
    process only, chat-only tracer bullet;
  - **IPC client** — renderer-side, satisfies the same interface by talking to
    main.
- **Call sites that must not change when behaviour is swapped:** the chat pane
  (asks a port for a stream) and the IPC handler in main (asks an adapter for a
  stream).
- **Enabling point A — renderer composition root:** what the chat pane is
  handed. IPC client in the running app; fake adapter in component tests.
- **Enabling point B — main composition root:** which adapter the IPC handler
  serves. Fake by default; SDK only when the SDK launch flavor is used.

The evidence file's candidate seams 2 (renderer-side port handle) and 3
(main-process adapter selection) are **not separate seams here** — they are
these two enabling points of seam 1.

### Seam 2 — The log sink (forced by DoD 6, carries no product behaviour)

- **Interface:** one writer with `append(record)`, constructed once at startup
  and passed to everything that logs.
- **Implementations:** JSONL file under repo-local `logs/`; in-memory buffer
  for the forwarding test.
- **Call sites:** main lifecycle, the agent-port logging decorator (D5), IPC
  error paths, the renderer-console forwarder (`webContents`
  `console-message` / `preload-error`).

### Not seams

BrowserWindow construction, `electron.vite.config.ts`, ESLint config, the
React tree above the chat pane. Scaffolding — nothing to swap.

---

## 2. Decision ledger

### D1 — The chat pane always speaks over IPC · **proposed**

In the running app the pane holds the IPC client and main decides fake vs SDK;
component tests hand the pane the fake adapter directly, because both satisfy
the same interface. Beats letting the renderer construct the fake in dev, which
would make the path agents drive (DoD 5) different from the shipped path and
would leave IPC untested at zero cost. Consequence: one fake adapter serves
both main and component tests; no second renderer-local fake.

### D2 — Four Crucible-owned events · **proposed**

Turn started, text delta, turn ended, error — each carrying a turn id.
Additive later. Beats mirroring the SDK's `AgentEvent` union (plus nested
`AssistantMessageEvent`), which would smuggle in a vocabulary we don't control
and make the fake adapter expensive. Anything the SDK adapter cannot map onto
these four (tools, compaction, retries) is dropped this milestone.

### D3 — `invoke` + correlated event channel, one narrow preload surface · **proposed**

`invoke('agent:prompt')` returns a turn id; main→renderer events are correlated
by that id. Preload exposes exactly one object (`window.crucible.agent`:
`prompt`, `onEvent`) — never raw `ipcRenderer`, unlike both official scaffolds.
No abort/steer this milestone; a prompt sent while streaming is rejected by main
with an error event.

### D4 — Keep `sandbox: true`, bundle the preload · **proposed**

Sandbox stays on (with contextIsolation on, nodeIntegration off, per DoD 1);
preload is bundled to a single file via electron-vite's isolated build
(`externalizeDeps: false`). Beats copying the official `react-ts` playground's
explicit `sandbox: false`. Cost: a little more Vite config, and preload cannot
`require` freely.

### D5 — Logging is a decorator at the agent-port seam · **proposed**

A logging decorator wraps *any* agent port and writes to the injected sink:
adapter identity, prompt, every event, every error. Both adapters get DoD 6
coverage for free and neither knows about logging. Sink is a hand-rolled JSONL
writer to `logs/`. Beats `electron-log` (OS log dirs, non-JSONL default) and
per-adapter log calls, which drift as adapters multiply.

### D6 — Two launch flavors, fake is the default, CDP always open · **aligned**

Human ruling (A1): plain `npm run dev` is **always** agent-drivable — the
remote-debugging port is open by default, not behind a separate script. There
must be **two launch flavors**, fake-backed and SDK-backed; the agent in the
repo picks by task (prompting work needs the real SDK behind it; pure UI/UX work
uses the fake). Fake remains the default.

Shape that satisfies it (**proposed** detail): `npm run dev` → fake adapter,
CDP port open; `npm run dev:sdk` → SDK adapter, CDP port open. Selection reaches
main as one env var (`CRUCIBLE_AGENT=fake|sdk`) read at `app.whenReady`; with no
env set, the answer is fake. Both flavors and the fixed port number are
documented in `AGENTS.md`. Evidence open #5 stands: that electron-vite forwards
`--remote-debugging-port` to Chromium is **unverified** — build must verify, and
if the flag does not pass through, use `app.commandLine.appendSwitch` in main
guarded by dev mode.

### D7 — "Proven against the real SDK once" is an opt-in script · **proposed**

A committed `npm run prove:sdk` that a human runs deliberately, never part of
`npm test`, with its output recorded as the evidence that it passed. Beats a
skipped-unless-env vitest case, which invites CI or an agent to spend money and
muddies the "all green" signal. (Related to but distinct from D6: `dev:sdk` is
for interactive work, `prove:sdk` is the one-shot proof.)

### D8 — The SDK adapter inherits credentials only · **aligned**

Human ruling (A2): inherit **no** settings from `~/.pi`. Crucible is its own
thing and merely uses the π SDK under the hood for the agentic loop. Credentials
(`auth.json`) only. Consequence: the SDK adapter starts from in-memory
session/settings with tools off, does **not** read `~/.pi/agent/settings.json`,
and therefore cannot load `packages: ["../../repos/pi-extensions"]` — which also
keeps the non-negotiable that nothing here depends on the legacy system at
runtime.

### D9 — Version control: git init, private GitHub repo · **aligned**

Human ruling (A3): `git init`, a `.gitignore`, and a **private** GitHub repo
`crucible` under the personal account `secondcircle`, committed and pushed.

Executed during this run (verified):

- `git init` → initial commit `fe55b08` on `main`, holding the pre-existing
  residue (`AGENTS.md`, `CONTEXT.md`, `docs/adr/`, `.crucible/`).
- `.gitignore` (**proposed** contents): `node_modules/`, `out/`, `dist/`,
  `logs/`, `.DS_Store`, `.firecrawl/`. `logs/` is the line DoD 6 depends on;
  note that the playground's `*.log*` would *not* have covered `logs/app.jsonl`.
  `.crucible/` is tracked deliberately (the dogfooding record), diverging from
  the legacy system's `.gitignore`.
- `gh repo create secondcircle/crucible --private --source=. --push` →
  https://github.com/secondcircle/crucible, visibility PRIVATE, default branch
  `main`, pushed.

### D10 — Test stack is Vitest + Testing Library + jsdom · **aligned**

Human ruling (A4): real-browser component testing excluded for now; Vitest +
Testing Library + jsdom confirmed. Playwright component testing is out. Test
layers per DoD 4: unit tests for main-process logic and adapters, component
tests for the chat pane against the fake adapter, plus the DoD 6 forwarding
test against an in-memory sink.

---

## 3. Invariants the build must not quietly vary

1. The renderer imports no π SDK type, directly or transitively (ADR 0001).
2. The default in every path an agent touches is the fake adapter; no paid call
   is reachable without an explicit `dev:sdk` / `prove:sdk` invocation.
3. The chat pane's only dependency for talking to an agent is the agent-port
   interface — not `window.crucible`, not `ipcRenderer`, not Electron.
4. One chronological JSONL stream. Main lifecycle, agent-port calls and events
   (with adapter identity), IPC failures, and renderer console/errors land in
   the same file, in order.
5. Nothing is copied from the legacy system.

## 4. Carried-forward uncertainty (for build to resolve, not to guess)

- **Unverified:** `--remote-debugging-port` reaching Chromium through
  `electron-vite dev` (D6 fallback noted above).
- **Unverified:** whether the on-disk credentials actually work — the D7 proof
  run is what settles it.
- **Open, deliberately:** log record schema beyond "JSONL with a timestamp,
  source, and turn id", file-per-run vs single file, rotation. Decide at
  implementation against the DoD 6 bar ("an agent can diagnose from the log
  alone"), behind seam 2 so it stays cheap to change.
- **Open, deliberately:** whether to start from the `@quick-start/electron`
  `react-ts` template or hand-roll. Either is fine provided D3 and D4 hold —
  the template's `sandbox: false`, its `window.electron.ipcRenderer`
  passthrough, and its electron-builder scripts must not survive.
