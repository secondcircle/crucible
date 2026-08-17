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
