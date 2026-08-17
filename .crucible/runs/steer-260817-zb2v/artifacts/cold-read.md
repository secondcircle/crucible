# Cold-read assessment — Zone A

## Assessment

**Leverage is not yet sufficient for a standalone steering instrument.** The page makes the architectural bet and most vetoes legible, but it leaves observable behavior open at the event lifecycle, busy UI, reload boundary, launch configuration, SDK model selection, and log-file boundary. Those are not merely implementation details: users, operators, or tests can distinguish the resulting builds.

## 1. The bet, restated

Build the smallest Electron/React chat surface around a Crucible-owned asynchronous agent interface rather than allowing React to depend on the π SDK. Production-shaped renderer traffic always crosses a narrow preload/IPC boundary into Electron main. Main chooses either a free canned adapter (the default) or a real, chat-only SDK adapter. The same port also permits jsdom component tests to inject the fake directly. Main is intended to serialize one turn at a time and to be the sole source of an ordered JSONL diagnostic log. The payoff is a cheap, agent-drivable UI skeleton whose vendor boundary can later be replaced.

## 2. Decision-by-decision veto leverage

| Decision | What I can veto | What vetoing means |
|---|---|---|
| **D1** | I can veto the Crucible-owned agent port as the renderer's exclusive agent dependency. | Permit renderer code/tests to use or mock SDK types directly, accepting vendor coupling and a less isolated free test surface; or require a different boundary before implementation. |
| **D2** | I can veto putting the SDK in main and/or the stated sandbox and preload posture. | Redraw the process/security boundary, likely use a generated scaffold or a renderer-side integration, and explicitly accept the security and coupling consequences. The decision bundles two choices, so a partial veto must reopen the bundle. |
| **D3** | I can veto the four-event protocol as too small or as the wrong abstraction. | Define a richer Crucible event model now, or mirror more SDK behavior, with correspondingly more fake/test work and a larger future-facing contract. |
| **D4** | I can veto making shipped chat always use IPC while tests inject the fake port directly. | Allow a renderer-local development fake, add a different composition seam, or require a stronger IPC-level test; doing so changes how much of the shipped path the default dev loop exercises. |
| **D5** | I can veto the two launch flavors, fake default, environment selection, or always-on dev debugging. | Choose a different safe default/config mechanism or separate agent-driving launch path, accepting extra operator ceremony or a different exposure posture. |
| **D6** | I can veto single-flight refusal. | Queue, steer, follow up, cancel, or permit concurrent turns instead; this requires a different ordering and UI model rather than the stated busy error. |
| **D7** | I can veto the exact narrow preload surface. | Expose a broader capability or IPC primitive and accept the larger renderer authority/security surface, or choose another narrowly typed bridge. |
| **D8** | I can veto logging as a decorator around every selected adapter. | Put instrumentation in adapters/handlers, use another logging package, or reduce what is recorded, trading away uniform seam coverage or changing privacy/diagnostic behavior. |
| **D9** | I can veto main as the sole log writer and sink-assigned total sequence. | Allow multiple writers or a different centralized logging service, while giving up the simple claim that one in-process authority orders every record unless another authority is named. |
| **D10** | I can veto Vitest/Testing Library/jsdom and the exclusion of browser tests. | Add real-browser/component/E2E coverage now or use another test stack, paying the setup/runtime cost in exchange for testing more Electron/browser behavior. |
| **D11** | I can veto inheriting only default-resolved credentials while isolating settings and disabling tools. | Require explicit credentials/model configuration or inherit selected user settings, accepting either more setup or renewed runtime coupling to user/legacy configuration. |
| **D12** | I can veto the manual, opt-in real-SDK proof. | Put a paid proof under controlled automation, use an env-gated/skipped test, or omit it; each changes the risk of accidental spend and the strength/freshness of real-SDK evidence. |

### Dead lines

None of D1–D12 is dead: each exposes a choice that can be vetoed and a meaningful consequence. Some decisions are bundled or incompletely specified, but they still provide reviewer leverage.

## 3. What the page cannot answer

A reviewer would still need answers to these questions:

1. **Who owns turn IDs at every seam?** Main is said to mint them, while fake, SDK, and IPC client are all said to satisfy the same `prompt -> turn id` port, including direct fake injection that bypasses main. The page does not explain the internal adapter contract that makes both statements true, nor where collision and stale-event checks live.
2. **What are the semantic payloads of the four events?** In particular: whether errors carry a safe display message, stable code, raw cause/stack, or retryability; whether `turn ended` carries final metadata; and what renderer text is safe to expose or log.
3. **What happens to the existing turn after an overlapping prompt is refused?** The likely answer is “it continues,” but continuation, cancellation, and guard release are not stated, especially if refusal logging or event delivery itself fails.
4. **What are the subscription guarantees?** The page does not state replay versus live-only delivery, behavior with multiple subscribers, whether unsubscribe is idempotent, or whether synchronous adapter events can occur before `prompt` resolves.
5. **What is the lifecycle on window close, renderer crash, app quit, or adapter disposal?** This matters especially for whether a paid SDK request continues and how the single-flight guard and subscriptions are released.
6. **What is the log failure policy?** An unwritable directory, serialization failure, sink backpressure, or app exit with buffered records could fail startup, fail a turn, or be ignored. No flush/durability rule is given.
7. **Exactly which renderer/preload diagnostics are forwarded?** “Console output” and “preload errors” do not identify levels, uncaught exceptions/rejections, early preload failures, serialization/redaction, or whether normal DevTools output remains intact.
8. **What security boundary applies to remote debugging?** The binding address, exposure to other hosts/users, port collision behavior, and production disablement are absent.
9. **How are invalid inputs/configuration handled?** Empty prompts, malformed IPC payloads, unknown adapter values, duplicate terminal events, and events carrying an unknown/stale turn id have no stated policy.
10. **How is the transitive renderer import fence actually defined and checked?** The page promises lint failure for a direct SDK import and says no SDK type may cross transitively, but does not identify renderer/shared module boundaries or an enforcement capable of catching transitive leaks.
11. **What exactly proves the SDK tracer bullet?** The prompt, timeout, pass/fail criterion, cost bound, evidence redaction, and cleanup behavior of `prove:sdk` are not specified.
12. **What repeatable Agent Browser procedure is acceptance evidence?** The connection/discovery command, readiness signal, selectors/actions, expected canned output, and failure diagnostics are not provided on this page.

## 4. Divergence test

### Divergence 1 — event lifecycle cardinality

**VERBATIM SENTENCE:** “Turn started, text delta, turn ended, error; one terminal event closes a turn.”

**BUILD A:** Every accepted turn emits exactly one `turn started`, zero or more deltas, and exactly one terminal `turn ended` or `error`, including `started -> error` for an immediate SDK failure.

**BUILD B:** Only the terminal-event rule is mandatory; an immediate validation/SDK failure emits `error` without `turn started`, while successful turns emit `turn started` and deltas.

**OBSERVABLE DIFFERENCE:** A port test sees different event sequences, and the pane can show an assistant-turn placeholder before an immediate error in Build A but only an error line in Build B.

### Divergence 2 — busy interaction in the chat pane

**VERBATIM SENTENCE:** “`agent:prompt` returns a turn id, events come back tagged with it, and a prompt arriving mid-turn is refused as the new turn's terminal error.”

**BUILD A:** The pane disables its input/send control while a turn is live; the handler still implements refusal for races or non-UI callers.

**BUILD B:** The pane leaves input/send enabled so a user can submit during streaming and renders the resulting new turn's terminal error.

**OBSERVABLE DIFFERENCE:** During streaming, a user or component test either cannot submit a second prompt at all or can submit it and sees a correlated error line.

### Divergence 3 — remote-debugging port discovery

**VERBATIM SENTENCE:** “`npm run dev` runs the fake adapter, `npm run dev:sdk` the SDK adapter, both with the debugging port open; `CRUCIBLE_AGENT` carries the choice and unset means fake.”

**BUILD A:** Both scripts always expose Chromium debugging on a documented fixed port such as 9222 and fail clearly if it is occupied.

**BUILD B:** The scripts request a dynamic available port and reveal it only in process output or Chromium's port file.

**OBSERVABLE DIFFERENCE:** An agent can always run a fixed `agent-browser connect` command in Build A; in Build B it must parse/discover the port, and a fixed acceptance command fails.

### Divergence 4 — unknown adapter configuration

**VERBATIM SENTENCE:** “`npm run dev` runs the fake adapter, `npm run dev:sdk` the SDK adapter, both with the debugging port open; `CRUCIBLE_AGENT` carries the choice and unset means fake.”

**BUILD A:** Any nonempty value other than the recognized fake/SDK values fails startup with a configuration error.

**BUILD B:** Any unrecognized value falls back to the fake just as an unset value does.

**OBSERVABLE DIFFERENCE:** With `CRUCIBLE_AGENT` misspelled, an operator either gets an immediate failure or gets a working canned chat while potentially believing the real SDK is selected.

### Divergence 5 — active turn across renderer reload

**VERBATIM SENTENCE:** “*Interface, in prose:* the agent port again, renderer-side, plus one fact — events stop at a window reload, so the pane resubscribes on mount.”

**BUILD A:** Main lets the active adapter turn continue; the remounted pane receives only events emitted after its new subscription, with no replay.

**BUILD B:** Reload/window unsubscription terminates or detaches the active turn and releases single-flight state, so the newly mounted pane starts clean.

**OBSERVABLE DIFFERENCE:** Reloading mid-stream yields a partial/terminal-only response and may leave sending busy in Build A; Build B loses that turn but immediately permits a new prompt.

### Divergence 6 — real-SDK model selection

**VERBATIM SENTENCE:** “It picks up `~/.pi/agent/auth.json` through the SDK's default resolution and otherwise starts from in-memory session and settings, tools off.”

**BUILD A:** Crucible explicitly places a particular provider/model in the in-memory settings, independent of user settings.

**BUILD B:** Crucible supplies no model and lets the SDK infer a default from available credentials or its own built-in fallback.

**OBSERVABLE DIFFERENCE:** `prove:sdk` can call a different provider/model, incur a different cost, produce different capability/error behavior, or fail for lack of a selectable default.

### Divergence 7 — log-file/session boundary

**VERBATIM SENTENCE:** “After a session, `logs/` holds one JSONL file in which main lifecycle, the prompt, adapter identity, every event and a renderer console line appear in one order.”

**BUILD A:** Each Electron process launch creates a new timestamped JSONL file; repeated launches accumulate one file per launch.

**BUILD B:** The app always appends to one stable JSONL file, treating the repository's ongoing dev activity as the session and separating launches only with lifecycle records.

**OBSERVABLE DIFFERENCE:** After two launches, an operator sees two independently bounded files in Build A and one combined history in Build B; log cleanup, diagnosis, and sequence-number scope differ.
