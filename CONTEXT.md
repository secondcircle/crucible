# Crucible

The ubiquitous language of this repository. Open it before naming anything —
a type, a file, a component, a document heading — and use these words exactly.
`/align` is its only writer.

## Language

**Crucible**:
The whole app: a personal development system built on top of π, whose core is
the workflow engine and whose surface is this Electron app. Not any single
piece of it.
_Avoid_: using "Crucible" to mean only the extensions, only the engine, or
only the UI.

**Legacy system**:
The TUI-based π extension workspace at `../pi-extensions`, where Crucible
first grew. A read-only reference: pieces are chosen and rebuilt here one at a
time, and nothing here depends on it at runtime.
_Avoid_: the old app, the extensions repo.

**Agent port**:
The Crucible-owned interface between the UI layer and everything agent-side.
The only path by which the UI reaches an agent — a hedge against ever leaving
the π SDK, and the seam every UI test runs against.
_Avoid_: SDK wrapper, mock boundary.

**Fake adapter**:
The agent-port implementation that answers with canned responses — no
network, no cost. What agents and tests drive the app with; the default in
dev mode.
_Avoid_: mock, stub.

**SDK adapter**:
The agent-port implementation backed by the real π SDK.
_Avoid_: real backend, live mode.
