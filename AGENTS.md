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

Other scripts: `npm run lint`, `npm run typecheck`, `npm test`.
