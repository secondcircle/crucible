# Seam proposal — Crucible Electron boilerplate

**Run:** `steer-260817-zb2v` · **Date:** 2026-08-17 · **Reads:** intent brief `260817-electron-boilerplate.md`, `evidence.md`, `CONTEXT.md`, ADR 0001

This is the gate document. Two minutes: skim the two seam sections, then answer
the six questions. Anything you don't answer, I'll take my recommendation and
mark it `proposed`.

---

## Where the new behaviour attaches

The repo is empty — no `package.json`, no `src/`, not even a git repo — so
there are no existing seams to prefer. Every seam here is one we are choosing
to create. The discipline is therefore to create as few as possible.

**One behavioural seam: the agent port.** Everything the milestone can vary
— fake vs SDK, in-process vs across IPC, logged vs not — varies at that one
interface. ADR 0001 already bought it.

**One sink seam: the log writer.** Forced, not chosen: DoD 6 requires a
meaningful test that renderer console/errors reach the merged JSONL stream,
and that test is only fast and deterministic if the file writer is
replaceable. It carries no product behaviour.

The evidence file lists four candidate seams. Seams 2 (renderer-side port
handle) and 3 (main-process adapter selection) are **not separate seams** in
this proposal — they are the two *enabling points* of seam 1, one on each side
of the process boundary. Collapsing them is the main structural claim here,
and D1 is where you veto it.

### Seam 1 — The agent port

- **Interface:** Crucible-owned, in shared TypeScript. Prompt in, event
  stream out. No π SDK type crosses it (ADR 0001).
- **Implementations:** **fake adapter** (canned stream, pure TS, no Electron,
  no network), **SDK adapter** (`createAgentSession` → `prompt`/`subscribe`,
  main process only), and an IPC client in the renderer that satisfies the
  same interface by talking to main.
- **Call sites that never change:** the chat pane (asks a port for a stream)
  and the IPC handler in main (asks an adapter for a stream).
- **Enabling point A (renderer composition root):** what the chat pane is
  handed — the IPC client in the app, the fake adapter in component tests.
- **Enabling point B (main composition root):** which adapter the IPC handler
  serves — fake by default, SDK when explicitly asked.

### Seam 2 — The log sink

- **Interface:** one `append(record)` writer, constructed once at startup and
  passed to everything that logs.
- **Implementations:** JSONL file under repo-local `logs/`; in-memory buffer
  for tests.
- **Call sites:** main lifecycle, the agent-port logging decorator (see D5),
  IPC error paths, the renderer-console forwarder
  (`webContents` `console-message` / `preload-error`).

Not seams, deliberately: BrowserWindow construction, Vite config, ESLint,
the React tree above the chat pane. Scaffolding, nothing to swap.

---

## Decisions that most deserve your veto

### D1 — Does the chat pane ever hold an adapter directly, or does it always speak over IPC?

**Recommendation:** always over IPC. In the running app the pane holds an IPC
client; main decides fake vs SDK. Component tests hand the pane the fake
adapter directly, because both satisfy the same interface.
**Beats:** letting the renderer construct the fake adapter in dev. That would
make the thing agents drive (DoD 5) a *different* code path from the shipped
one, and the IPC layer would never be exercised at zero cost.
**Cost of my choice:** the fake adapter runs in main, so a Node-side fake
serves both the app and the main-process tests, while component tests import
that same fake directly — one fake, two call sites, no second renderer fake.

### D2 — How thin is the agent-port event vocabulary, and whose names does it use?

**Recommendation:** four Crucible-owned events for this milestone —
turn started, text delta, turn ended, error — with a turn id on each.
Additive later.
**Beats:** mirroring the SDK's ten-member `AgentEvent` union (plus the nested
`AssistantMessageEvent`) under new names. That imports a vocabulary we don't
control through the back door and makes the fake adapter expensive to write.
**Watch:** anything the SDK adapter can't map onto four events (tools,
compaction, retries) is dropped this milestone, not queued.

### D3 — What crosses IPC, and what does preload expose?

**Recommendation:** `invoke('agent:prompt')` returning a turn id, plus a
main→renderer event channel correlated by that turn id; preload exposes
exactly one narrow object (`window.crucible.agent`: `prompt`, `onEvent`), no
raw `ipcRenderer`.
**Beats:** the official electron-vite playground's `window.electron.ipcRenderer`
passthrough — which Electron's own docs call unsafe, and which would let the
renderer reach any channel.
**Also decided by this:** no abort/steer in milestone 1; a prompt sent while
streaming is rejected by main with an error event.

### D4 — Do we keep `sandbox: true` and bundle the preload, or follow the template's `sandbox: false`?

**Recommendation:** keep the sandbox on, bundle preload into one file
(electron-vite isolated build / `externalizeDeps: false`).
**Beats:** the official `react-ts` playground, which sets `sandbox: false`
explicitly, and electron-vite's own troubleshooting page, which presents that
as the fix for preload module errors. DoD 1 says sandboxed; Q4 flagged the
process model as proposed-and-accepted, so this is your call to reverse.
**Cost:** slightly more Vite config, and preload can't `require` freely.

### D5 — Is agent-port logging a decorator at the seam, or log calls inside each adapter?

**Recommendation:** a logging decorator that wraps *any* agent port and writes
to the injected sink — adapter identity, prompt, every event, every error —
so both adapters get DoD 6 coverage for free and neither knows about logging.
Sink is a hand-rolled JSONL writer to `logs/`.
**Beats:** `electron-log` (defaults to `~/Library/Logs/...`, not JSONL, not
repo-local — bendable but not a drop-in) and scattered `log()` calls inside
adapters, which drift the moment a third adapter appears.

### D6 — How is the adapter chosen in main, and what does "proven against the real SDK once" actually run?

**Recommendation:** one env var (`CRUCIBLE_AGENT=fake|sdk`) read at
`app.whenReady`; **fake is the default with no env set**, so every agent path
is free. The SDK proof is a committed, opt-in `npm run prove:sdk` script that
a human runs deliberately; it is never part of `npm test`, and its output goes
in the run log as the evidence that it passed.
**Beats:** a skipped-unless-env vitest case, which invites CI or an agent to
accidentally spend money and pollutes the "all green" signal.

---

## Ambiguities where a wrong guess costs a redraft

### A1 — Is DoD 5 satisfied by a *separate* command that opens the CDP port?

DoD 5 needs Agent Browser, which needs the app launched with
`--remote-debugging-port`. Whether electron-vite forwards that flag is
**unverified** (evidence, open #5). I'd add `npm run dev:agent` that launches
with a fixed port (9222) and documents it in `AGENTS.md`, leaving plain
`npm run dev` alone. If you intend `npm run dev` itself to always be
agent-drivable, say so — it changes what the dev script is.

### A2 — Should the SDK adapter inherit the user's `~/.pi/agent` settings?

Those settings contain `packages: ["../../repos/pi-extensions"]` — i.e.
default `createAgentSession()` may load the **legacy system** into a live
session, which reads against "nothing here depends on it at runtime". I'd have
the SDK adapter start from in-memory session/settings with `noTools: "all"`
and inherit **only** credentials (`auth.json`). Confirm, because the opposite
reading is that a chat tracer should look exactly like the TUI.

### A3 — Should this milestone `git init` and write `.gitignore`?

There is no git repo here. DoD 6 says logs live in a "gitignored location",
which is meaningless without one, and Q9's "nothing lands unless decided
here" makes me unwilling to assume. I'd `git init` and commit a `.gitignore`
with `node_modules/`, `out/`, `dist/`, `logs/`. One word from you settles it.

### A4 — Does "component tests" permit only jsdom/happy-dom?

Q6 said fast unit + component, no browser E2E. Playwright component testing
runs in a real browser — fast-ish, but a browser. I'm reading it as excluded
and going Vitest + Testing Library + jsdom. Flag if you meant otherwise; it
changes the test toolchain, not the seams.
