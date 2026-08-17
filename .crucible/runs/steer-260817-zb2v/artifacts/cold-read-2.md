# Cold-read leverage assessment — Zone A

## Verdict

**`leverageOk: false`.** The page communicates a strong module boundary and gives useful alternatives and reversal costs, but it is not yet a standalone steering instrument. In particular, it leaves observable behavior open around event timing, reload cancellation, SDK retries/compaction, and the location of turn-id/single-flight authority. Those are implementation forks rather than harmless syntax choices.

## 1. The bet, restated

Build a minimal Electron/React chat application around a Crucible-owned, prompt-in/event-stream-out agent port. Keep the real π SDK and its types in Electron main, carry the port over a narrow preload/IPC channel, and inject the same port directly into component tests. The normal development path uses a deterministic fake so the shipped IPC/UI path can be exercised for free; an opt-in flavor and proof script use the real SDK. Main also owns a single JSONL logging stream so failures can be reconstructed. The bet is that this one seam buys cheap UI testing now and makes replacing or expanding the SDK integration later tractable.

## 2. Decision-by-decision veto leverage

No decision is a dead line: each states enough policy, alternative, or consequence for me to object to it meaningfully.

- **D1 — Crucible-owned agent port.** I can veto the strict ownership/import fence if SDK coupling is acceptable or if maintaining a translation layer costs more than the hedge is worth. Vetoing means allowing SDK contracts into UI/shared code and testing against SDK-shaped fakes, knowingly increasing replacement cost.
- **D2 — SDK in main with a sandboxed renderer.** I can veto the hand-rolled secure scaffold if speed or a generated scaffold is more important, or challenge the placement of the SDK in main. Vetoing means accepting broader renderer capability or moving agent execution elsewhere, with an explicit security tradeoff.
- **D3 — Four port events.** I can veto the minimal event vocabulary if tools, retry state, cancellation, usage, or richer completion reasons are needed in the first vertical slice. Vetoing means enlarging the Crucible contract now or mirroring more of the SDK, making the fake and UI more expensive.
- **D4 — Shipped chat always traverses IPC.** I can veto requiring IPC in ordinary development if a renderer-local fake is more valuable for iteration. Vetoing means the default UI path no longer proves preload/main/IPC behavior and requires separate integration coverage.
- **D5 — Two launch flavors, fake default, fixed debugging port.** I can veto the implicit fake fallback, a permanently enabled debugger, or the fixed port. Vetoing means requiring an explicit adapter selection and/or a separate debug launch path, trading agent convenience for clearer configuration or reduced exposure/conflicts.
- **D6 — Single-flight with refused overlap.** I can veto refusal in favor of queueing, cancellation, steering, follow-up, or concurrency. Vetoing changes turn state, UI controls, and the IPC contract; it is not a local pane change.
- **D7 — One narrow preload object.** I can veto the exact bridge granularity if more capabilities must be exposed or independently versioned. Vetoing means a broader/multiple preload API, but need not imply unsafe raw `ipcRenderer` passthrough.
- **D8 — Logging decorator at the port.** I can veto logging raw prompts/events at this seam on privacy or fidelity grounds, or prefer adapter-specific telemetry. Vetoing means redaction/metadata-only logging, logging elsewhere, or accepting incomplete uniform coverage.
- **D9 — Main as sole log writer.** I can veto a single combined stream if process-local logs or an external collector are operationally better. Vetoing means giving up sink-assigned total order or introducing an explicit aggregation/order protocol.
- **D10 — Vitest/Testing Library/jsdom only.** I can veto omission of browser/Electron automation if sandbox, preload, IPC, or rendering failures are too important to leave to an agent-driven check. Vetoing adds a real-browser or packaged-Electron test layer and its maintenance cost.
- **D11 — Inherit credentials only.** I can veto isolated in-memory settings if matching the operator's provider/model/configuration is required. Vetoing means loading selected or all user settings and accepting renewed coupling to legacy packages unless those settings are filtered.
- **D12 — Real-SDK proof as an opt-in script.** I can veto a human-only proof if continuous compatibility evidence is required. Vetoing means a controlled paid integration job/test with explicit secrets and budget, or dropping the claim of ongoing real-SDK compatibility.

## 3. What a reviewer still needs to know

The page cannot answer these questions:

1. **What is the complete agent-port contract?** The payload fields and semantics of started, delta, ended, and error are absent, as are the distinction between a rejected prompt, a transport failure, and an accepted turn that fails. Cancellation/disposal behavior is also unspecified.
2. **Which provider and model does Crucible name, and how?** No identifiers or configuration source are given, so the real-SDK flavor and proof script do not have a reviewable target.
3. **What privacy and retention policy applies to logs?** Prompts and model output can be sensitive, but redaction, permissions, retention, filename uniqueness, size limits, and behavior on serialization/write failure are not stated. The deliberately deferred record schema does not settle these operational questions.
4. **What exactly is the deterministic fake contract?** The canned reply, delta boundaries, cadence, scheduler, and whether tests may override the script are unstated. A reviewer cannot tell whether a component test is proving a stable behavior or merely its own fixture.
5. **How are SDK lifecycle events translated?** The page does not identify which SDK signals establish start/end/error, how partial output followed by failure is represented, or what happens when SDK subscription/session creation fails before prompting.
6. **What constitutes a successful `prove:sdk` run?** There is no expected provider/model, timeout, maximum spend/request count, cleanup rule, or required evidence format beyond “pastes the output.”
7. **How broad is the renderer import fence?** “Even transitively” is the right goal, but the page does not say whether the check covers type-only imports, shared modules, preload dependencies, dynamic imports, and dependency re-exports.
8. **What is the scope of single-flight ownership?** The page does not settle whether it is per window, per SDK session, or application-global if another window or non-renderer caller is introduced.

## 4. Divergence test

### Divergence 1 — “Dropped” behavior versus dropped event representation

**VERBATIM SENTENCE:** “Tools, compaction and retries are dropped this milestone.”

**BUILD A:** The SDK retains its own compaction and retry behavior; `toPortEvent` merely filters their SDK events out of the four-event Crucible stream. The user sees only resulting text or a final error.

**BUILD B:** The SDK is configured so tools, automatic compaction, and retries do not run at all; the first context-limit or transient provider failure terminates the turn.

**OBSERVABLE DIFFERENCE:** Under a transient provider failure or context limit, Build A may issue another paid request, take longer, and eventually return text, while Build B issues no retry/compaction request and immediately renders an error. Logs, cost, latency, and terminal UI state differ.

### Divergence 2 — Event delivery relative to the returned turn id

**VERBATIM SENTENCE:** “`agent:prompt` returns a turn id and events come back tagged with it; the pane disables send while a turn is live, and a prompt that arrives mid-turn anyway is refused as the new turn's terminal error while the live turn runs on.”

**BUILD A:** The main handler mints and returns the turn id before starting adapter work, establishing a happens-before edge from prompt resolution to the first event.

**BUILD B:** The handler starts the adapter immediately and returns the id through the Electron invoke promise independently; a synchronous or very fast fake can emit started and deltas before that promise resolves.

**OBSERVABLE DIFFERENCE:** A port/IPC test sees the first event only after `await prompt()` in Build A but can see it before prompt resolution in Build B. A pane that associates events only after receiving the id reliably renders all deltas in Build A but can discard or misassociate early deltas in Build B.

### Divergence 3 — What reload does to underlying work

**VERBATIM SENTENCE:** “*Interface, in prose:* the agent port again, renderer-side, plus one fact — a window reload ends the live turn and releases the guard, so the remounted pane starts clean.”

**BUILD A:** Reload actively cancels/disposes the adapter's in-flight SDK operation, stops further events, then releases the guard.

**BUILD B:** Reload only detaches the old renderer/event destination and clears the main guard; the underlying SDK operation continues because the stated port has no cancellation operation, while the remounted pane may start another turn.

**OBSERVABLE DIFFERENCE:** After reloading during a real turn, Build A stops provider work and produces no later old-turn events. Build B can incur continued cost, append old-turn events to the log, and run old and new SDK work concurrently even though the UI appears clean.

### Divergence 4 — Main authority versus directly injected port implementations

**VERBATIM SENTENCE:** “Ordering authority for prompts is main's `agent:prompt` handler, which mints turn ids and refuses a prompt overlapping a live turn.”

**BUILD A:** Main owns id minting and single-flight behavior; adapters are effectively lower-level producers. The directly injected fake needs separate local id/guard behavior (or lacks the shipped guard), and main retags or ignores adapter-local ids.

**BUILD B:** Each fake/SDK port implementation mints ids and enforces single-flight so it remains behaviorally complete when injected directly; the main handler delegates and returns the adapter's id despite being described as the authority.

**OBSERVABLE DIFFERENCE:** A test that invokes the directly injected fake twice during a live turn can receive two accepted turns in Build A but a started/error refusal for the second in Build B. A handler test can also observe a main-generated id in Build A versus the fake's deterministic id in Build B. Thus the component-test substitute and the shipped IPC port do not necessarily have the same behavior.

## Structured verdict

```json
{
  "leverageOk": false,
  "deadLines": [],
  "unanswerables": [
    "The complete payload and failure/cancellation semantics of the four-event agent-port contract are unspecified.",
    "The real SDK provider/model identifiers and their configuration source are unspecified.",
    "Log privacy, redaction, retention, permissions, uniqueness, limits, and sink-failure behavior are unspecified.",
    "The fake reply, delta cadence/scheduling, and fixture override contract are unspecified.",
    "The exact SDK lifecycle-to-port-event mapping, including pre-prompt failures and partial output followed by failure, is unspecified.",
    "The success, timeout, spend, cleanup, and evidence criteria for prove:sdk are unspecified.",
    "The scope and mechanism of the transitive renderer SDK import fence are unspecified.",
    "Whether single-flight is per window, per session, or application-global is unspecified."
  ],
  "divergences": [
    "VERBATIM: ‘Tools, compaction and retries are dropped this milestone.’ BUILD A filters those SDK events but leaves SDK compaction/retries active. BUILD B disables the behaviors. OBSERVABLE: request count, spend, latency, and success-versus-error differ under context or transient failures.",
    "VERBATIM: ‘agent:prompt returns a turn id and events come back tagged with it; the pane disables send while a turn is live, and a prompt that arrives mid-turn anyway is refused as the new turn's terminal error while the live turn runs on.’ BUILD A returns the id before adapter events; BUILD B can emit before the invoke promise resolves. OBSERVABLE: callback ordering differs and early deltas may render versus be lost/misassociated.",
    "VERBATIM: ‘Interface, in prose: the agent port again, renderer-side, plus one fact — a window reload ends the live turn and releases the guard, so the remounted pane starts clean.’ BUILD A cancels underlying work; BUILD B only detaches and clears the guard. OBSERVABLE: old work/cost/log events stop in A but may continue concurrently with a new turn in B.",
    "VERBATIM: ‘Ordering authority for prompts is main's agent:prompt handler, which mints turn ids and refuses a prompt overlapping a live turn.’ BUILD A keeps authority in main and gives the direct fake separate or weaker behavior; BUILD B puts id/single-flight authority in each adapter and has main delegate. OBSERVABLE: direct-fake overlap acceptance/refusal and ids observed in handler tests differ."
  ]
}
```
