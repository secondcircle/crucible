# Cold-read leverage assessment — Zone A

## 1. The bet, restated

Build the first Electron UI around a Crucible-owned, streaming agent interface rather than around π SDK types. The shipped renderer always exercises that interface through a narrow preload/IPC channel; main chooses either a deterministic fake (the default, so UI work and tests are free) or a deliberately selected real SDK adapter. Main also owns single-flight admission and one ordered JSONL log. The milestone succeeds if the same shallow chat pane works against both adapters, is component-testable in jsdom, can be driven through Chromium remote debugging, and leaves enough evidence to diagnose a run.

This is a coherent architectural bet: spend boilerplate effort on one durable boundary so UI work is cheap and replacing the SDK remains possible.

## 2. Decision-by-decision veto leverage

| Decision | What I can veto | What vetoing would mean |
|---|---|---|
| **D1 — renderer reaches agents only through the agent port** | I can veto the owned boundary or its absolute ban on transitively exposed SDK types. | The renderer would program against/mock the SDK directly, accepting vendor coupling and a more expensive UI-test surface, or the proposal would need a different anti-corruption boundary. |
| **D2 — SDK only in main, sandboxed renderer** | I can veto main-process placement, the security settings, or the hand-rolled scaffold justified by them. | We would either accept SDK/Electron capability in the renderer, weaken the sandbox/context-isolation defaults, or choose a generated scaffold and explicitly repair its defaults. This changes a high-cost security boundary. |
| **D3 — four port events** | I can veto the four-event vocabulary or its lifecycle rule. | The milestone would expose richer concepts such as tools/retries/compaction, mirror more of the SDK, or adopt a different completion/error protocol; fake, SDK mapping, IPC, pane, and tests would all change. |
| **D4 — pane always uses IPC in the app** | I can veto exercising IPC in the ordinary dev path or veto dependency-injecting the port into the pane. | Dev could mount a renderer-local fake and leave shipped IPC less exercised, or the pane could construct/read a global client and lose its simple jsdom seam. |
| **D5 — two launch flavors, fake default, debugger always on** | I can veto the fake-on-unknown fallback, the two-script UX, or mandatory fixed-port debugging. | Selection could fail closed, require an explicit flavor, use another discovery/configuration scheme, or make debugging an opt-in mode. Agent launch instructions and failure behavior would change. |
| **D6 — one turn at a time** | I can veto refusal-based single flight. | The app would need queuing, steering, follow-up semantics, or cancellation, and would need corresponding UI and ordering rules rather than disabling send and refusing overlap in main. |
| **D7 — exactly one narrow preload object** | I can veto the exact bridge shape or the prohibition on generic IPC passthrough. | The renderer could receive a broader Electron bridge or separate globals, trading convenience for a larger security/API surface; alternatively the same narrow capability would need a differently named/versioned contract. |
| **D8 — logging decorator at the port seam** | I can veto decorator-based logging or logging every adapter uniformly. | Logging would move into adapters/channel code or to a logging package, with duplicated instrumentation and different coverage/format tradeoffs. |
| **D9 — main is the sole log writer** | I can veto the single-writer authority or per-launch repo-local JSONL stream. | Multiple processes would need an explicit merge/ordering protocol, or logs would move to separate files/OS locations. The claim of one authoritative sequence would have to be weakened or redesigned. |
| **D10 — Vitest, Testing Library, jsdom only** | I can veto the test stack or the exclusion of browser tests. | The milestone would add a real-browser/component/E2E layer or use another runner, increasing setup cost while covering browser-only behavior more directly. |
| **D11 — inherit credentials only** | I can veto isolation from user settings or the tools-off, explicitly selected model setup. | The SDK adapter would intentionally inherit some π settings/tools, or Crucible would define another configuration source. That reopens runtime coupling, reproducibility, capability, and cost concerns. |
| **D12 — real-SDK proof is an opt-in script** | I can veto keeping paid proof outside the automated suite or veto its script form. | Real-SDK validation would become an env-gated/skipped test, a CI/manual checklist, or part of another launch flow, requiring explicit controls against accidental spend. |

**Dead lines:** none. Every numbered decision presents a rejectable choice and a meaningful consequence, helped substantially by the “Instead of,” rationale, enforcement point, and reversal cost. “Enforced: stated, not enforced” is weak assurance for D10 and D12, but it does not make either line impossible to veto.

## 3. What this page cannot answer

A reviewer would still need the following before approving implementation behavior rather than only the architectural direction:

1. **The actual port data contract.** The page does not say the payload and invariants of `started`, `delta`, `ended`, and `error`; whether `ended` contains authoritative final text or usage; the public error shape; turn-id type/uniqueness; or which values must survive structured clone.
2. **The exact overlap protocol.** It does not settle whether a refused prompt emits `started` before `error`, despite distinguishing “accepted” turns in D3 and “refused” turns in D6.
3. **The real provider and model.** D11 says Crucible names both but supplies neither names nor a source of those names. Cost, credential compatibility, and reproducibility therefore cannot be reviewed.
4. **What `prove:sdk` actually does.** Its prompt, whether it is headless or launches the app, its exit/success criteria, output format, and what is safe to paste into evidence are unstated.
5. **The log contract and privacy policy.** Fields beyond four named candidates are explicitly open. The page cannot answer redaction of prompts/model errors/console values, behavior on serialization or append failure, filename collision/retention, or which console levels and preload failures are captured.
6. **Reload and cancellation mechanics.** “Reload disposes the session” does not define which Electron lifecycle event is authoritative, whether HMR/full navigation/crash/close are equivalent, when the guard is released relative to SDK cancellation, or how a fresh adapter/session is made available afterward.
7. **Remote-debugging failure and exposure.** There is no required behavior when port 9222 is occupied, nor a stated bind/exposure policy for the debugging endpoint.
8. **The fake’s acceptance fixture.** The canned reply, number/cadence of deltas, timer determinism, and error scenario are not fixed, so the promised component test and the human-visible “Hello agent” check have no shared expected transcript.
9. **Non-agent IPC failures.** It is unclear how preload invocation failure, renderer disappearance, event-send failure, and log-sink failure are translated, surfaced, and made terminal without violating exactly-once completion.
10. **SDK session inputs other than the few exclusions.** “In-memory session and settings” plus “inherits credentials and nothing else” does not state the working directory, system prompt, model parameters, or any other defaults that affect the proof’s output and cost.

## 4. Divergence test

### Divergence 1 — terminal event semantics

**VERBATIM SENTENCE:** “Turn started, text delta, turn ended, error.”

**BUILD A:** `turn ended` is a payload-free completion marker. The pane retains the text accumulated from deltas and merely marks that message complete.

**BUILD B:** `turn ended` carries authoritative final text (and potentially completion metadata). The pane replaces/reconciles accumulated delta text with the terminal value.

**OBSERVABLE DIFFERENCE:** A port contract test and the JSONL log see different terminal payloads. If the adapter’s final text differs from the concatenated deltas—for example after normalization or a missed delta—the user sees the accumulated text in A and the terminal authoritative text in B.

### Divergence 2 — lifecycle of a refused overlapping prompt

**VERBATIM SENTENCE:** “`agent:prompt` returns a turn id and events come back tagged with it; the pane disables send while a turn is live, and a prompt that arrives mid-turn anyway is refused as the new turn's terminal error while the live turn runs on.”

**BUILD A:** Main mints and returns a new turn id for the refused request and emits `started` followed by `error`, treating refusal as the “immediate failure” described in D3.

**BUILD B:** Main mints and returns the id but emits only `error`, because D3 promises `started` only for an *accepted* turn and D6 calls this request *refused*.

**OBSERVABLE DIFFERENCE:** An IPC/handler test and any programmatic caller that bypasses the disabled button observe two events in A and one in B. The log likewise either contains or omits a `started` record for the refused turn.

### Divergence 3 — provider/model selection

**VERBATIM SENTENCE:** “It picks up `~/.pi/agent/auth.json` through the SDK's default resolution and otherwise starts from in-memory session and settings — tools off, provider and model named by Crucible rather than inferred.”

**BUILD A:** `createSdkAdapter` hard-codes one provider/model pair as Crucible constants, so `dev:sdk` and `prove:sdk` run without further configuration.

**BUILD B:** Crucible defines and requires its own environment/config keys for provider and model, passing those explicit values to the in-memory settings rather than allowing SDK inference.

**OBSERVABLE DIFFERENCE:** With only the documented credentials present, A makes a model call while B refuses to start for missing configuration. When configured, the two builds can call different providers/models, producing different billing, latency, token behavior, and output.

### Divergence 4 — meaning of the proof script

**VERBATIM SENTENCE:** “A human runs `npm run prove:sdk` once, sees real model text stream, pastes the output into the evidence file; `npm run dev:sdk` shows the same pane on the real SDK.”

**BUILD A:** `prove:sdk` is a headless smoke program that sends a fixed prompt through the SDK adapter, streams port events to stdout, and exits success after `ended`.

**BUILD B:** `prove:sdk` launches the Electron SDK flavor and leaves the human to type a prompt in the pane; the visible pane transcript is the proof output.

**OBSERVABLE DIFFERENCE:** The operator running the same command gets an automatically terminating terminal transcript and machine-checkable exit status in A, versus an open Electron window requiring manual input and shutdown in B. The evidence pasted from each is consequently a different artifact.

## Assessment

The page has high decision leverage and unusually clear module boundaries, scope fences, and a named single ordering authority. Nevertheless, it does **not** pass as a standalone steering instrument yet: four material behaviors can be implemented observably differently, including the central port lifecycle and the paid real-SDK path. Resolve those divergences and make the provider/model and public event semantics explicit; the remaining unanswered operational details can then be deliberately accepted or separately aligned.
