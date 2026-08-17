# Crucible Electron boilerplate — an agent port the UI can be tested against

**PRD · draft · 2026-08-17 · from the alignment conversation of 2026-08-17.**
Snapshot of intent, not a contract. Not updated after implementation;
regenerated if the plan changes materially. Evidence: `evidence.md`.
Reviewer path: 199 lines, as the format's lint counts them.

## The bet

Crucible has no surface of its own: the engine lives in the legacy system's TUI and there
is nowhere to build a real UI. Built the obvious way — React on the π SDK — every UI test
costs money and the app is welded to a vendor's types. So the boilerplate is built around
one seam: an electron-vite + React app whose renderer reaches agents only through a
Crucible-owned agent port — fake adapter by default, chat-only SDK adapter as the tracer
bullet. After this an agent can launch the app, send "Hello agent", watch a canned reply
stream in at zero cost, and diagnose what broke from the log.

## Where to push back

- **D2** — the π SDK in main behind typed IPC was accepted on my say-so, not chosen.
- **D3** — four port events for the whole milestone. Too thin to grow from?
- **A1** — that `electron-vite dev` forwards `--remote-debugging-port=9222` to Chromium is
  unverified, and agent-driven verification rests on it.
- Left open deliberately: the log record's fields past timestamp, sequence, source, turn id.
- Nothing else is blocked; the other open questions have their own aligns.

## Decisions

### D1 ⚠ The renderer reaches agents only through the agent port · aligned

Prompt in, event stream out, in Crucible-owned TypeScript shared by main and renderer;
no π SDK type crosses it, even transitively.
*Instead of:* mocking the SDK's own `AgentSession` in UI tests.
*Because:* one leaked SDK type kills both the free test surface and the hedge against
leaving the π SDK.
*Enforced:* the renderer import fence (Contracts).
*Reversal cost:* expensive

### D2 ⚠ The π SDK runs only in main, behind a sandboxed renderer · proposed

`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, preload bundled to one
file so it loads under the sandbox, renderer loaded from electron-vite's dev URL so edits
hot-reload — hence a hand-rolled scaffold, not a generated one.
*Instead of:* the electron-vite `react-ts` playground, whose loudest defaults
(`sandbox: false`, `ipcRenderer` passthrough, electron-builder) this run bans.
*Because:* a security default switched off during boilerplate is never switched back on.
*Enforced:* `createMainWindow` — its `webPreferences` and its dev-URL load (Contracts).
*Reversal cost:* expensive

### D3 ⚠ The port speaks four Crucible-owned events, each with a turn id · proposed

Turn started, text delta, turn ended, error. Every accepted turn emits started, then zero
or more deltas, then exactly one terminal event — an immediate failure is started, then
error. Tool, compaction and retry events are dropped by the mapping: tools are off at the
session (D11), while compaction and retries stay the SDK's own business.
*Instead of:* mirroring the SDK's `AgentEvent` union and its nesting.
*Because:* the fake adapter hand-writes every event; a foreign union makes it expensive.
*Enforced:* `toPortEvent` in the SDK adapter (Contracts).
*Reversal cost:* moderate

### D4 The chat pane always speaks over IPC; its port is handed to it · proposed

In the app the pane holds the IPC client and main picks the adapter; component tests hand
the same pane the fake adapter directly.
*Instead of:* constructing the fake inside the renderer in dev.
*Because:* agents must drive the shipped path; a renderer fake leaves IPC untested.
*Enforced:* `mountApp`, the renderer composition root — the only place a port is built.
*Reversal cost:* moderate

### D5 Two launch flavors, fake by default, remote debugging always on · aligned

`npm run dev` runs the fake adapter, `npm run dev:sdk` the SDK adapter, both with Chromium
debugging on the fixed port 9222; `CRUCIBLE_AGENT` carries the choice, and unset or
unrecognized means fake.
*Instead of:* a separate "agent-drivable" script beside a normal `dev`.
*Because:* an agent who must remember a second script drives the wrong app.
*Enforced:* `selectAdapter`, sole reader of `CRUCIBLE_AGENT` (Contracts).
*Reversal cost:* cheap

### D6 One turn at a time, correlated by turn id · proposed

`agent:prompt` returns a turn id and events come back tagged with it; the pane disables
send while a turn is live, and a prompt that arrives mid-turn anyway is refused as the new
turn's terminal error while the live turn runs on.
*Instead of:* the SDK's `streamingBehavior: "steer" | "followUp"`.
*Because:* Electron has no invoke-for-streams; refusal is renderable, steering is a feature.
*Enforced:* the single-flight guard in main's `agent:prompt` handler.
*Reversal cost:* moderate

### D7 Preload exposes exactly one object · proposed

`window.crucible.agent`, with `prompt` and `onEvent`; `onEvent` forwards payloads only,
never the Electron event.
*Instead of:* the `window.electron.ipcRenderer` passthrough the scaffolds ship.
*Because:* Electron's context-isolation doc calls that passthrough the unsafe pattern, and
the narrow object is all the IPC client needs.
*Enforced:* preload's single `contextBridge.exposeInMainWorld` (Contracts).
*Reversal cost:* cheap

### D8 Logging is a decorator at the agent-port seam · proposed

`withLogging(port, sink)` wraps any adapter and records adapter identity, the prompt,
every event and every error; no adapter knows logging exists.
*Instead of:* log calls inside each adapter, or adopting `electron-log`.
*Because:* coverage arrives with the seam; `electron-log` writes non-JSONL to OS log dirs.
*Enforced:* `withLogging`, applied to every port `selectAdapter` returns.
*Reversal cost:* cheap

### D9 Main is the sole writer of the log stream · proposed

One sink with `append(record)`, built at startup, passed everywhere, and writing one file
per launch under `logs/`; the renderer writes nothing — its console output and preload
errors forward to main.
*Instead of:* renderer and main both appending to the same file.
*Because:* "one chronological stream" is an ordering claim two writers cannot make.
*Enforced:* the log sink's `append` in main — the only writer.
*Reversal cost:* moderate

### D10 Vitest + Testing Library + jsdom; unit and component tests only · aligned

Unit tests for main-process logic and adapters, component tests for the pane against the
fake adapter, plus the renderer-forwarding test.
*Instead of:* Playwright component testing in a real browser.
*Because:* real-browser testing is out for now; Agent Browser covers the real renderer.
*Enforced:* stated, not enforced
*Reversal cost:* moderate

### D11 The SDK adapter inherits credentials and nothing else · aligned

It picks up `~/.pi/agent/auth.json` through the SDK's default resolution and otherwise
starts from in-memory session and settings — tools off, provider and model named by
Crucible rather than inferred.
*Instead of:* inheriting the user's π settings along with the credentials.
*Because:* those settings load `packages: ["../../repos/pi-extensions"]`, making Crucible
depend on the legacy system at runtime.
*Enforced:* `createSdkAdapter`'s in-memory session construction (Contracts).
*Reversal cost:* cheap

### D12 "Proven against the real SDK once" is an opt-in script · proposed

`npm run prove:sdk` is committed, run deliberately by a human, never part of `npm test`.
*Instead of:* a vitest case skipped unless an env var is set.
*Because:* a skipped test invites CI or an agent to un-skip it and spend money.
*Enforced:* stated, not enforced
*Reversal cost:* cheap

## Shape

**Agent port** — the Crucible-owned interface between the UI layer and everything
agent-side.
*Interface, in prose:* two operations — send a prompt, answered with a turn id once
accepted; subscribe, answered with an unsubscribe. A turn's events arrive in order, live
only, and close with one terminal event; they can begin before the prompt call resolves, so
a caller subscribes first. Whoever answers a prompt mints its turn id, and single-flight
lives in exactly one place — main's `agent:prompt` handler, the ordering authority, which
refuses a prompt overlapping a live turn; an adapter driven straight from a test serves
whatever it is asked. A caller need not know which adapter answered, whether a process
boundary was crossed, or that the call was logged.
*Hidden behind it:* SDK session lifecycle, event translation, IPC correlation, adapter
selection, logging — all five reappear in the chat pane if the port is deleted, and it
stops being mountable in jsdom.
*Seam:* the one behavioural seam this milestone creates; three adapters satisfy it — fake,
SDK, IPC client — so it is real, not hypothetical. *Tested through:* itself.

**Fake adapter** — the canned-response implementation, and the default.
*Interface, in prose:* the agent port, with a scripted reply split into deltas; imports
neither Electron nor the SDK, so one module serves main, node unit tests and jsdom tests.
*Hidden behind it:* delta cadence and the scripted turn — the one place a test's expected
output lives. *Seam and tested through:* the agent port.

**SDK adapter** — the implementation backed by the real π SDK, main only.
*Interface, in prose:* the agent port; SDK failure becomes the turn's terminal error.
*Hidden behind it:* `createSdkAdapter`'s in-memory session and settings with tools off,
`createAgentSession`/`prompt`/`subscribe`, and `toPortEvent`, which maps the SDK union to
the four. *Seam and tested through:* the agent port — SDK stubbed, real once via `prove:sdk`.

**Agent channel** — preload surface, main handler and renderer IPC client together: the
port made to work across the process boundary.
*Interface, in prose:* the agent port again, renderer-side, plus one fact — a window reload
disposes the adapter's session, so the underlying work stops rather than running on unseen,
the guard is released, and the remounted pane starts clean.
*Hidden behind it:* channel names, turn-id correlation, structured-clone limits, the
single-flight guard, `selectAdapter`. *Seam and tested through:* the agent port — handler
under unit test with the fake adapter, client under component test.

**Chat pane** — the walking skeleton: message list, input, send.
*Interface, in prose:* mounted with a port; renders deltas as they arrive and the terminal
event as a finished message or an error line; send is disabled while a turn is live. Its
only agent-side dependency is the port — not `window.crucible`, not Electron.
*Hidden behind it:* nothing yet; deliberately shallow and unstyled. *Seam:* its props,
filled by `mountApp` in the app and by the test in jsdom. *Tested through:* Testing
Library, against the fake adapter.

**Log sink** — the single writer of the run log.
*Interface, in prose:* `append(record)`, one JSONL line each, sequence numbers assigned by
the sink; constructed once, passed everywhere. *Hidden behind it:* the per-launch file under
repo-local `logs/`, directory creation, serialization, ordering. *Seam:* the sink object —
JSONL file and in-memory buffer. *Tested through:* the buffer.

End-to-end, fake flavor: `npm run dev` starts electron-vite on port 9222 with
`CRUCIBLE_AGENT` unset; main builds the sink, calls `selectAdapter` (fake), wraps it in
`withLogging`, registers the `agent:prompt` handler and opens `createMainWindow`;
`mountApp` hands the IPC client to the pane; a send invokes `agent:prompt` for a turn id;
the handler drives the wrapped adapter and pushes tagged events to the window, which the
client rebuilds into port events. `npm run dev:sdk` changes one step: `selectAdapter`
returns the SDK adapter.

## Assumptions

| # | We're assuming | If it's wrong | Settled by |
| --- | --- | --- | --- |
| A1 | `electron-vite dev` forwards `--remote-debugging-port=9222` to Chromium | main sets the switch itself in dev mode; no design change | launch it and run `agent-browser connect 9222` |
| A2 | The on-disk π credentials are valid | `prove:sdk` fails; the milestone still lands on the fake adapter | run `prove:sdk` once |
| A3 | Four events carry a walking-skeleton chat | D3 grows by addition, not redesign | build the fake adapter and the pane against them |
| A4 | jsdom component tests plus agent-driven checks cover the renderer | a browser test layer is a later align, not this one | the Agent Browser pass in DoD 5 |
| A5 | A bundled preload loads under `sandbox: true` with electron-vite | fall back to a preload with no imports at all | first window that opens |
| A6 | The log schema can be settled at implementation | rework confined behind the log sink | write one session's log and read it back |

## Not doing

Everything here is a scope fence: not built, nothing refuses it at runtime.

- **Packaging, auto-update, CI** — the milestone's product is a dev loop.
- **Styling and design** — the pane is unstyled on purpose; design gets its own aligns.
- **Browser E2E and Playwright component tests** — ruled out for now (D10).
- **Login/logout UI** — credentials come from TUI use (D11); own align.
- **Multi-turn history, sessions, model picker** — one align per feature.
- **Anything carried over from the legacy system** — reference only.

Refused at runtime rather than absent, hence a Decision not a fence: overlapping prompts (D6).

## Done looks like

- `npm run dev` opens the app with HMR, renderer sandboxed.
- An agent launches the app, connects Agent Browser, sends "Hello agent" and watches the
  canned reply stream into the pane — no paid call anywhere.
- A human runs `npm run prove:sdk` once, sees real model text stream, pastes the output into
  the evidence file; `npm run dev:sdk` shows the same pane on the real SDK.
- A component test on the fake asserts the rendered reply; unit tests cover adapters, handler, sink.
- After a session, that launch's JSONL file in `logs/` shows main lifecycle, the prompt,
  adapter identity, every event and a renderer console line in one order.
- `npm run lint`, `npm run typecheck` and `npm test` are green, and lint fails on a π SDK
  import added to the renderer.

---

**End of the reviewer path.** Everything below is for implementing agents: