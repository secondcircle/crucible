# Crucible

An Electron desktop app powered by the π SDK (`@earendil-works/pi-coding-agent`
— the SDK, not the TUI).

We are migrating capabilities from the **legacy system** — the TUI-based π
extension workspace at `../pi-extensions` — one deliberately chosen piece at a
time. When anything here says "legacy system", it means that repository. It is
a read-only reference; nothing depends on it at runtime.

`CONTEXT.md` at the root is this repository's glossary — use its words
exactly. `docs/adr/` holds the decisions that were hard to reverse, one
paragraph each. Read them when naming things or questioning a shape.

Current focus: stand up the Electron boilerplate so the app is testable
(especially the UI), maintainable, and extensible, with clean seams at the
agent/SDK boundary so tests can run against fakes.

## Driving the app

`npm run dev` starts the app with Chromium remote debugging on the fixed port
**9222**, so an agent can drive the running window:

```
npm run dev            # electron-vite dev --remoteDebuggingPort=9222
agent-browser connect 9222
agent-browser snapshot
```

The port exists in dev only — nothing here ships a packaged build — and it
binds loopback (`127.0.0.1:9222`). Check it with
`lsof -nP -iTCP:9222 -sTCP:LISTEN`. Only one launch can hold 9222: a second
`npm run dev` still opens a window but logs `bind() failed: Address already in
use` and is not debuggable, and `agent-browser connect 9222` silently attaches
to the *first* app. Quit the stale one before connecting.

`npm run dev` is the **fake** launch flavor: canned replies, no paid call, and
what every agent-driven check should use. That is the fake flavor's *only*
purpose — UI checks and anything else that doesn't need a real model. The
human never uses it.

## The paid flavor, and the two scripts that use it

`npm run dev:sdk` is the same app and the same window on the real π SDK
(`CRUCIBLE_AGENT=sdk`), so a turn there costs money. When the human wants to
try out code that isn't installed yet — a worktree, a branch, uncommitted
changes — this is the flavor to launch for them, by default and without
asking. They will actually be using the app, so canned replies are useless to
them; a human test means a real environment. The human launching (or asking
for) `dev:sdk` *is* the spending authorization for that session. `npm run prove:sdk` is the
one-shot proof that the SDK adapter still works: one short turn, headless,
printing the model id and the date, exiting non-zero unless it saw
`turn_started`, a `text_delta` and `turn_ended` within 60 seconds. Run it only
with explicit human authorization; the human may run it or direct an agent to
execute and record it. Paste its stdout beside that authorization in the
evidence file. It is never part of `npm test`, and `npm test` constructs no SDK
adapter at all.

Other scripts: `npm run lint`, `npm run typecheck`, `npm test`.
