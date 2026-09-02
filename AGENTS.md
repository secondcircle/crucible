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

`npm run dev` starts the app with Chromium remote debugging on **this
checkout's own port**, so an agent can drive the running window:

```
npm run dev                                   # prints the port as it starts
PORT=$(npm run dev:port --silent)             # the same port, any time
agent-browser connect "$PORT"
agent-browser snapshot
```

The port is 9222 in the primary clone and a stable port in 9223-9292 in every
run worktree, derived from its path by `scripts/dev-port.sh` — so concurrent
runs never contend, and a given worktree answers on the same port every time.
`CRUCIBLE_DEBUG_PORT` overrides it. Never hard-code 9222: in a worktree it is
the wrong window, and connecting to it means driving somebody else's app.

The port exists in dev only — the installed app never opens it — and it binds
loopback. Check yours with `lsof -nP -iTCP:$(npm run dev:port --silent)
-sTCP:LISTEN`.

The vite dev server gets the same treatment. `scripts/renderer-port.sh` gives
this checkout a pinned port in 5222-5292, mirroring the debug port one for
one. Left to itself vite slides off a busy 5173 to the next free port while
electron-vite still points the window at 5173, so the window loads *another*
checkout's renderer and the app you drive is not the code you are testing.
Nothing says so. Pinned, a collision fails the launch instead. When a window
surprises you, check it with `agent-browser get url`, which must read
`http://localhost:$(bash scripts/renderer-port.sh)/`. The CLI can also hold a
session open against an app you connected to earlier, and that reads as the
same symptom.

**Never kill by name or pattern.** `pkill -f Crucible` and `killall Electron`
match `/Applications/Crucible.app` and take down the human's live app, its
running turn with it. That is the one unrecoverable mistake available here. To
stop *your own* dev launch, take the PID off your own port and kill only that:

```
kill $(lsof -tnP -iTCP:$(npm run dev:port --silent) -sTCP:LISTEN)
```

Usually you need not stop anything at all — your port is yours. If it is
already held, the holder is your own earlier launch in this same checkout, so
reconnect to it instead of restarting it.

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

## The installed app

Crucible is installed from npm: `npm install -g` the package `package.json`
names leaves a real desktop app on a Mac, on Windows and on Linux — in
Applications and the Dock, in the Start Menu, in the launcher. The package's postinstall assembles
it (`src/main/install/`), which is why one platform-neutral publish serves all
three: `out/` is JavaScript and electron's own postinstall fetches that
machine's binary. A packaged launch always runs the SDK adapter: there is no
flavor switch, no env var, no debug port. Its state lives under the platform's
appData as `Crucible`; every dev launch uses `Crucible-Dev` instead, so no
worktree or branch under test can ever touch the installed app's sessions.

Updates flow on their own, for the author exactly as for everybody else: a
push to `main` that passes typecheck, lint and tests is published to npm by CI
with a bumped patch version (`.github/workflows/publish.yml`), and every
installed Crucible checks the registry at launch and every 15 minutes, stages
a newer version and assembles it into its own bundle in the background. Only
then does it offer the "Update ready · Restart" pill in the top bar and the
same restart on the version strip at the foot of the sidebar. Restarting is
always the human's click, never automatic — a restart mid-turn drops that
turn.

Agents never touch the installed app or its state: don't launch it, don't
install or reinstall it, don't read or write its userData, and never click its
restart pill for the human. Testing happens through `npm run dev`
(agent-driven) or `npm run dev:sdk` (for the human) in whatever checkout holds
the code under test.
