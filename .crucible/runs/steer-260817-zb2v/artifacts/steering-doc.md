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
error. Ended carries no text: a turn's text is its accumulated deltas, nothing reconciles
them after the fact. Tool, compaction and retry events are dropped by the mapping: tools are off at the
session (D11), while compaction and retries stay the SDK's own business. An SDK
failure is provisional until `session.prompt()` finishes: a recovered retry never crosses as
an error, while an exhausted retry closes the port turn with its final failure.
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

`agent:prompt` returns a turn id, events come back tagged, the pane disables send while a
turn is live, and a prompt arriving mid-turn is refused as the new turn's terminal error
while the live one runs on; reload, close or quit disposes that session and frees the guard.
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

One sink with `append(record)`, built at startup, passed everywhere, writing one file per
launch under `logs/`, appending synchronously and dropping any record it cannot write; the
renderer writes nothing — its console output and preload errors forward to main.
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
*Amended 2026-08-18:* the interim pin is `openai-codex/gpt-5.4-mini`. A bare
Anthropic SDK session misses the legacy `anthropic-pi-symbol` extension's system-prompt
rewrite and routes to extra usage rather than subscription usage. Port that behavior before
re-pinning Anthropic; it is a later upgrade, not part of this milestone.
*Reversal cost:* cheap

### D12 "Proven against the real SDK once" is an opt-in script · proposed

`npm run prove:sdk` is committed, run only on a human's explicit authorization (an agent may
execute and record it at the human's direction — amended 2026-08-18), never part of `npm test`.
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
- A human authorizes `npm run prove:sdk` once (running it themselves or directing an agent to);
  real model text streams, and the stdout goes into the evidence file beside the recorded
  authorization; `npm run dev:sdk` shows the same pane on the real SDK.
- A component test on the fake asserts the rendered reply; unit tests cover adapters, handler, sink.
- After a session, that launch's JSONL file in `logs/` shows main lifecycle, the prompt,
  adapter identity, every event and a renderer console line in one order.
- `npm run lint`, `npm run typecheck` and `npm test` are green, and lint fails on a π SDK
  import added to the renderer.

---

**End of the reviewer path.** Everything below is for implementing agents:
contracts, edge cases, verified facts, and the build order. Do not promote
material from below this line on a rewrite.

## Contracts

The agent port, shared by main and renderer (D1, D3, D6):

```ts
export type TurnId = string;

export type PortEvent =
  | { type: "turn_started"; turnId: TurnId }
  | { type: "text_delta"; turnId: TurnId; delta: string }
  | { type: "turn_ended"; turnId: TurnId }
  | { type: "error"; turnId: TurnId; code: "busy" | "adapter"; message: string };

export interface AgentPort {
  /** Accepted, not finished: resolves with the turn id once the turn starts. */
  prompt(text: string): Promise<TurnId>;
  /** Returns an unsubscribe, like the SDK's own subscribe. */
  onEvent(listener: (event: PortEvent) => void): () => void;
}
```

Every `PortEvent` is a plain object so it survives Electron's structured clone.

Sequencing, subscription and identity, all elaborating D3 and D6:

- Every accepted prompt produces exactly one `turn_started`, then zero or more
  `text_delta`, then exactly one terminal event (`turn_ended` or `error`). An
  immediate failure is still `turn_started` then `error` — there is no bare-error
  sequence for a port to produce or a test to expect.
- Whoever answers `prompt` mints the turn id for that call: main's handler for
  everything crossing IPC, the adapter itself when a test drives it directly. Ids
  are unique per port instance (`t-1`, `t-2`, … is enough); no adapter invents an
  id for a turn it was not asked for.
- Subscription is live-only: no replay, no backlog. Multiple listeners are allowed
  and each gets every event; unsubscribe is idempotent; events may arrive before
  the `prompt` promise resolves, so a caller subscribes first and prompts second.
- `error.message` is display-safe text for the pane. Stacks, SDK error objects and
  provider payloads go to the log (D8), never into the event.
- The renderer's IPC client drops any event whose turn id it does not know — a
  stale event after reload cannot append to a fresh transcript.

The preload surface — the whole of it (D7):

```ts
// src/preload/index.ts — the single exposeInMainWorld call
contextBridge.exposeInMainWorld("crucible", {
  agent: {
    prompt: (text: string) => ipcRenderer.invoke("agent:prompt", text),
    onEvent: (cb: (e: PortEvent) => void) => {
      const h = (_e: IpcRendererEvent, ev: PortEvent) => cb(ev); // payload only
      ipcRenderer.on("agent:event", h);
      return () => ipcRenderer.off("agent:event", h);
    },
  },
});
```

Window construction — `createMainWindow`, the sole `BrowserWindow` (D2):

```ts
webPreferences: {
  preload: join(__dirname, "../preload/index.mjs"),
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
}
// and, in the same function, the load that makes HMR real:
process.env.ELECTRON_RENDERER_URL
  ? win.loadURL(process.env.ELECTRON_RENDERER_URL)   // dev: vite serves, edits hot-reload
  : win.loadFile(join(__dirname, "../renderer/index.html"));
```

The preload must be one file for this to load: electron-vite isolated build,
`externalizeDeps` off for the preload config, and no `require` beyond what a
sandboxed preload is allowed — `electron`, `events`, `timers`, `url` (plus their
`node:` spellings), which is the whitelist Facts on file cites.

The SDK adapter's construction and mapping — `createSdkAdapter` and `toPortEvent`
(D3, D11):

```ts
// D11 — option names verified against the installed SDK's CreateAgentSessionOptions.
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  settingsManager: SettingsManager.inMemory(),   // default would read ~/.pi/agent/settings.json
  model: getBuiltinModel("openai-codex", "gpt-5.4-mini"), // Crucible's interim constants
  noTools: "all",
});
// agentDir stays default — that is the whole of "credentials only": the model
// runtime still resolves ~/.pi/agent/auth.json, while the in-memory settings
// manager keeps `packages: ["../../repos/pi-extensions"]` unread. getBuiltinModel
// comes from "@earendil-works/pi-ai/providers/all" (compat's getModel is deprecated).
```

```
// D3 — toPortEvent: the whole mapping. Anything absent from this table is dropped.
turn_start                                          -> turn_started
message_update + assistantMessageEvent.text_delta   -> text_delta   (.delta)
turn_end                                            -> turn_ended
message_update + assistantMessageEvent.error        -> provisional error (code "adapter")
message_end + assistant stopReason "error"          -> provisional error (code "adapter")
throw from prompt()                                 -> error        (code "adapter")
```

The installed SDK folds provider failures into assistant `message_end` rather than exposing
its typed `assistantMessageEvent.error` through `AgentSession.subscribe`. Both rows stay in
the mapping. They update the port turn's provisional outcome, but do not settle it until
`session.prompt()` returns: transient retries remain the SDK's business and a recovered
reply replaces the provisional failure; an exhausted retry emits its last failure.

The adapter owns the session it made: `dispose()` on window close, reload or app
quit, which is also what releases the single-flight guard (D6). Two failure shapes
sit either side of a turn: a session that cannot be created at all (bad credentials,
unknown model) is logged at startup and turns the *first* prompt into a terminal
`error` with `code: "adapter"`; a turn that fails mid-stream keeps its deltas, and
the pane appends the error line under the partial text.

The fake adapter's script (D4, and what the Shape entry means by "the one place a
test's expected output lives"): the reply text and its delta split are exported
constants in the fake's own module, so tests import them instead of duplicating
strings, and the inter-delta pause is a constructor parameter whose default gives
a visible stream in the app while tests pass zero and never wait on a timer.

`prove:sdk`, the one-shot proof (D12): prompts `"Say hello in five words."` against
`createSdkAdapter`, prints each port event, and exits non-zero unless it saw
`turn_started`, at least one `text_delta`, then `turn_ended` within 60 seconds. One
turn, tools off, no caller retry loop, so the spend is one short completion (the SDK may
retry transient provider failures internally). Its stdout goes into evidence with the model
id, date, and explicit human authorization; credentials are never printed.

The Agent Browser recipe DoD 5 is written against (D5): `npm run dev`, then
`agent-browser connect 9222`, `snapshot -i`, fill the message input, click send,
`wait --text` for the canned reply. Port 9222 is fixed and documented in
`AGENTS.md`, and exists in dev alone, since this run ships no packaged build.
Electron documents the switch as `--remote-debugging-port=port` and documents
`app.commandLine.appendSwitch('remote-debugging-port', …)` before `ready` as the
in-main way to set it — that is A1's fallback. What Electron does *not* document
is which interface the port binds to, so slice 1 checks it with
`lsof -nP -iTCP:9222 -sTCP:LISTEN` and records the address in evidence; treat
off-loopback binding as a finding to fix, not as expected.

Log record, one JSON object per line (D8, D9). Zone A settles four fields and
deliberately leaves the rest to implementation (A6), so this is the whole of the
fixed part:

```json
{"ts":"2026-08-17T09:12:03.412Z","seq":17,"source":"main","turnId":"t-3"}
```

`seq` is assigned by the sink, so ordering is a property of the file rather than
of clock resolution, and `turnId` is present on anything belonging to a turn.
`source` has to distinguish at least `main` from `renderer`, because D9's claim
that forwarded renderer output lands in the same stream is only checkable if a
reader can tell the two apart. One file per launch, named from its start time
(`logs/2026-08-17T09-12-03.jsonl` is a shape, not a mandate), so `seq` is scoped
to a run and an agent diagnosing "what happened when I ran it" opens one file (D9).

What the rest of each record must convey comes from D8 — which adapter answered,
the prompt, each event, each error — but the field names, levels and nesting are
the implementer's to choose against the DoD 6 bar, and cheap to change because
everything goes through one `append`. Two constraints only: records stay
single-line JSON, and nothing is added that would need a second writer.

Launch flavors — `selectAdapter`, the only reader of the env (D5):

| Invocation | `CRUCIBLE_AGENT` | Adapter | Paid calls |
| --- | --- | --- | --- |
| `npm run dev` | unset | fake | no |
| `npm run dev:sdk` | `sdk` | SDK | yes |
| `npm test` | unset (never read) | fake, injected by tests | no |
| `npm run prove:sdk` | `sdk` | SDK, headless script | yes |
| any value not `sdk` | anything | fake | no |

The renderer import fence — an ESLint rule over `src/renderer/**` (D1, D4):

```js
"no-restricted-imports": ["error", { patterns: [
  "@earendil-works/*", "electron", "**/main/**", "**/preload/**" ] }],
// plus no-restricted-syntax on member access to `window.crucible`,
// with src/renderer/src/agent/ipc-client.ts as the single exception.
```

The fence is a direct-import check; transitivity is covered by the shape of the
tree, not by the rule. The only module the renderer shares with main is the port's
type module, and that module imports nothing — an import added there is the one
edit that could smuggle an SDK type across, so it is the line to watch in review.

## Behaviour and edge cases

| Condition | Behaviour | Decision |
| --- | --- | --- |
| Prompt while a turn is streaming | the pane's send is disabled, so this is a race or a non-UI caller: new turn id minted, `turn_started` then `error` with `code: "busy"`; the live turn continues untouched and keeps the guard | D6 |
| Empty or whitespace-only prompt | undecided here — no Decision admits or refuses it, so this document sets no rule: pick one in slice 3, keep it in one place, and raise it if it turns out to matter | none |
| SDK throws inside `prompt` or emits an error event | terminal `error` with `code: "adapter"` and the SDK message; the turn never also emits `turn_ended` | D3 |
| SDK emits tool, thinking, compaction or retry events | `toPortEvent` returns nothing; the event is logged and dropped (level is the implementer's, per the Log record note) | D3 |
| `ipcMain.handle` throws | Electron serializes only `message`; so the handler never throws — it returns a turn id and reports through the event channel | D6 |
| Window reloads mid-turn | main disposes the turn, releases the guard and stops sending; the remounted pane starts empty and can prompt immediately | D6 |
| Window closed or app quits mid-turn | same disposal path; the SDK session is disposed so a paid request is not left running | D6 |
| Event arrives for an unknown or stale turn id | the IPC client drops it; nothing is rendered and one record is written | D6 |
| Second terminal event for a turn | the first one closed the turn; later events for that id are dropped as stale | D3 |
| Malformed IPC payload (non-string prompt) | same shape as any other handler failure: no throw crosses IPC, the caller gets a turn id and a terminal `error` | D6 |
| `CRUCIBLE_AGENT` unset, empty or unrecognized | fake adapter; `selectAdapter` puts the ignored value in the log, so a misspelt `sdk` is diagnosable rather than silent | D5 |
| Port 9222 already in use at launch | what Electron does is unverified and slice 1 settles it; the hazard to check is `agent-browser connect 9222` attaching to whatever else holds the port | D5 |
| Second window opened | cannot arise: `createMainWindow` is the only `BrowserWindow`, so single-flight is app-global by construction and the handler serves that window | D2 |
| `logs/` missing at startup | the sink creates it; failure to create is fatal for logging only, printed to stderr, app still runs | D9 |
| Renderer `console.*` and preload errors | all four levels (`debug`, `info`, `warning`, `error`) forwarded via `webContents` `console-message` / `preload-error`, appended by main with `source: "renderer"`, DevTools output unaffected | D9 |
| Renderer uncaught exception or unhandled rejection | reaches the same path as a console error; no separate channel | D9 |
| Log write fails mid-session | records are dropped, not buffered; the failure itself is printed to stderr once | D9 |
| App quits with records in flight | `append` writes synchronously, so there is nothing to flush; no exit-time buffer is kept | D9 |
| Prompts and replies in the log | written verbatim, no redaction this milestone: DoD 6 wants the prompt in the record, `logs/` is repo-local and gitignored, and nothing rotates or expires — revisit before any log leaves the machine | D8 |
| A turn fails after some deltas | the deltas stand; the pane keeps the partial text and appends the error line under it | D3 |
| Component test mounts the pane | fake adapter passed as a prop; nothing in the test touches `window.crucible` | D4 |
| `npm test` run with credentials present | still no network: no test constructs the SDK adapter | D12 |
| Fake adapter asked twice concurrently in a unit test | same single-flight refusal is main's, not the adapter's: the fake happily serves two turns | D6 |

## Build order

Each slice is a demoable path sized to one fresh context window.

1. **Scaffold and dev loop.** `package.json`, `electron.vite.config.ts`,
   `createMainWindow` with the D2 `webPreferences`, an empty React tree,
   scripts `dev`/`lint`/`typecheck`/`test`. Three checks close this slice: an
   edit to the React tree hot-reloads (D2's dev-URL load); `agent-browser
   connect 9222` then `snapshot` works, or the switch moves into main under a
   dev guard (A1); and `lsof -nP -iTCP:9222 -sTCP:LISTEN` shows what address
   the port bound to. Record all three, plus what a busy 9222 does, and
   document the port in `AGENTS.md`. Blocks everything.
2. **Log sink.** `append(record)`, one JSONL file per launch under `logs/`,
   in-memory adapter, main lifecycle records, unit test on the in-memory sink.
   Blocked by 1.
3. **Agent port and fake adapter.** The types in Contracts, the fake, the chat
   pane with send disabled while a turn is live, `mountApp` wired to a fake for
   now, component test in jsdom covering the full event sequence. No Electron
   involved. Blocked by 1.
4. **Renderer import fence.** The ESLint rule alone, with a deliberately
   failing fixture proving it fires on a π SDK import and on `window.crucible`
   outside the client. Its own slice; nothing consumes it here. Blocked by 3.
5. **Agent channel.** Preload surface, `agent:prompt` handler with the
   single-flight guard, `selectAdapter`, IPC client; `mountApp` switches to the
   client. End of this slice is DoD 5: Agent Browser, "Hello agent", canned
   reply. Blocked by 3 and 4.
6. **Logging at the seam.** `withLogging` around whatever `selectAdapter`
   returns, renderer console/preload-error forwarding, the forwarding test
   against the in-memory sink. Blocked by 2 and 5.
7. **SDK adapter and the proof.** `createSdkAdapter` with its pinned
   provider/model constants, `toPortEvent`, disposal on window close, unit tests
   with the SDK stubbed, `dev:sdk`, `prove:sdk` with the pass criterion in
   Contracts; a human runs it once and the output, with the model id and date,
   goes into the evidence file. Blocked by 5.

Slice 4 introduces an enforcement mechanism and stays alone for that reason;
its first consumer is slice 5.

## Glossary delta

Terms this work adds. `/align` is the single writer of `CONTEXT.md`; this is
residue for it, in that file's format.

**Agent channel**:
The renderer-side IPC client, the preload surface and the main-process handler
taken together — the agent port made to work across the process boundary. Its
interface is the agent port; it adds no operations.
_Avoid_: the IPC layer, the bridge.

**Turn**:
One prompt and everything the agent streams back for it, identified by a turn
id and closed by exactly one terminal event.
_Avoid_: request, message, exchange.

**Log sink**:
The single writer of Crucible's run log: `append(record)`, one JSONL line per
record. A file adapter in the app, an in-memory adapter in tests.
_Avoid_: logger, transport.

**Launch flavor**:
Which adapter a launch script puts behind the agent port — fake by default,
SDK on request. Both flavors are agent-drivable.
_Avoid_: mode, environment.

## Facts on file

- Repository has no application code: no `package.json`, `src/`, tests, lint or
  tsconfig; every file this milestone touches is new — evidence, "What exists
  today", and re-verified 2026-08-17 (draft pass).
- Git is initialized, `.gitignore` includes `logs/`, and
  `github.com/secondcircle/crucible` is private with default branch `main` —
  evidence, "draft pass" (2026-08-17); the seam sketch's version-control ruling
  is already executed, so no slice below re-does it.
- `@earendil-works/pi-coding-agent@0.84.2` is installed globally but is **not**
  importable from this repo until declared a dependency — evidence, "π SDK
  surface".
- Streaming text is nested: `message_update` → `assistantMessageEvent.type ===
  "text_delta"` → `.delta`; `prompt()` resolves only at end of turn and throws
  mid-stream without `streamingBehavior` — evidence, "π SDK surface".
- The SDK's own JSON wire form strips the cumulative `partial` snapshot from
  streaming events — prior art for a thin, cloneable event — evidence, "Event
  stream shape".
- `~/.pi/agent/settings.json` carries `packages:
  ["../../repos/pi-extensions"]`; inheriting it would pull the legacy system
  into a runtime session — evidence, "π SDK surface".
- Electron 20+ defaults `sandbox: true`; the official electron-vite `react-ts`
  playground sets `sandbox: false` explicitly and exposes
  `window.electron.ipcRenderer` — evidence, "Electron / electron-vite prior
  art".
- A sandboxed preload may only `require` `electron`, `events`, `timers`, `url`;
  multi-file CommonJS preloads do not load — evidence, same section.
- Electron IPC has no invoke-for-streams, and errors thrown in
  `ipcMain.handle` serialize to `{ message }` only — evidence, "IPC patterns".
- `webContents` `console-message` carries `message`, `level`, `lineNumber`,
  `sourceId` and `frame`; it and `preload-error` are the documented
  renderer→main hooks — evidence, "IPC patterns".
- Electron documents `--remote-debugging-port=port` ("Enables remote debugging
  over HTTP on the specified port") and shows
  `app.commandLine.appendSwitch('remote-debugging-port', '8315')` before `ready`;
  it documents no companion address switch, so the bind address is a thing to
  observe rather than configure — evidence, "revision pass 2" (2026-08-17).
- `CreateAgentSessionOptions` takes `sessionManager`, `settingsManager`, `model`,
  `noTools` and `agentDir`; its defaults are `SettingsManager.create(cwd,
  agentDir)` and `agentDir` = `~/.pi/agent`, so passing an in-memory settings
  manager is exactly what stops `settings.json` (and its `packages`) being read
  while auth resolution still works — evidence, "revision pass" (2026-08-17).
- `claude-fable-5` exists in the built-in anthropic catalog, and
  `getBuiltinModel` from `@earendil-works/pi-ai/providers/all` is the
  non-deprecated way to name it — evidence, "revision pass" (2026-08-17).
- `electron-log` defaults to OS log directories and a non-JSONL text format —
  evidence, "Logging prior art".
- The playground's `.gitignore` pattern `*.log*` would not ignore
  `logs/app.jsonl` — evidence, "Logging prior art".
- Agent Browser 0.34.0 is installed; its Electron skill requires
  `--remote-debugging-port=NNNN` at launch, then `agent-browser connect NNNN` —
  evidence, "Agent Browser".
- Local Node v25.9.0 satisfies both electron-vite (`>=22.12.0`) and the SDK
  (`>=22.19.0`) — evidence, "Environment facts".

## UNVERIFIED

| Claim | Best guess | One-shot check |
| --- | --- | --- |
| `electron-vite dev` forwards `--remote-debugging-port` to Chromium (A1) | it does not, cleanly; the switch belongs in main | launch and `agent-browser connect 9222` in slice 1 |
| The on-disk credentials still work (A2) | they do — the TUI uses them daily | `npm run prove:sdk`, once |
| A bundled preload loads under `sandbox: true` with electron-vite (A5) | yes, that is what isolated build is for | first window in slice 1 |
| `createAgentSession()` with default `agentDir` would load the legacy packages | it would; D11 avoids the question by using in-memory settings | log the loaded package list in `prove:sdk` |
| `claude-fable-5` is reachable with the credentials on disk | it is — the TUI uses that pair daily | the first `prove:sdk` run; a model error there means changing one constant |
| Chromium takes `--remote-debugging-port` on a fixed 9222 without collision on this machine | free; nothing else here listens | `agent-browser connect 9222` in slice 1 |
| The debug port binds loopback rather than every interface | loopback, as Chromium's DevTools endpoint normally is — but Electron documents no address switch and nothing here has checked | `lsof -nP -iTCP:9222 -sTCP:LISTEN` while the app runs, in slice 1 |
| Whether Playwright component testing counts as the E2E the human ruled out | it does, for now | not settled here; D10 stands until an align says otherwise |

## Prior art

| Source | Copy specifically |
| --- | --- |
| electron-vite `react-ts` playground | tree layout (`src/main`, `src/preload`, `src/renderer`), tsconfig split, ESLint 9 flat config, `index.html` CSP. Not `sandbox: false`, not the `ipcRenderer` passthrough, not electron-builder |
| electron-vite docs `/guide/isolated-build`, `/guide/dev` | the bundled-preload setup that makes `sandbox: true` viable; `ELECTRON_RENDERER_URL` vs `loadFile` for HMR |
| Electron docs `tutorial/ipc.md` | invoke/handle for the prompt, `webContents.send` + a narrow subscribe for the stream, and the warning not to hand the raw listener to `ipcRenderer.on` |
| π SDK `examples/sdk/01-minimal.ts` | the exact `createAgentSession` → `subscribe` → `prompt` → `dispose` shape the SDK adapter wraps |
| π SDK `dist/modes/json-event.d.ts` | the idea of a serializable event without cumulative snapshots — a model for `toPortEvent`, not a type to import |
| Agent Browser `electron` skill | the launch-with-CDP-port, connect, snapshot workflow that DoD 5 is written against |
