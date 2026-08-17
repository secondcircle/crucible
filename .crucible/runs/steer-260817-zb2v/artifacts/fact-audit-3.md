# Fact audit — steering-doc.md (run steer-260817-zb2v)

Scope: verify every checkable claim (paths, behaviours, names, payload shapes,
quotes) against the repo and `evidence.md`'s receipts; check Zone B introduces
no decisions absent from Zone A; check every invariant stated anywhere (Shape,
Done looks like, the Zone B behaviour table) traces to a Decision that
classifies it on an `*Enforced:*` line; check every Decision naming a choke
point names one that appears by that name in Shape or Contracts; check
`## Not doing` entries against contradicting Decisions. Findings triaged by
severity below.

---

## Blocking

### B1 — "Empty or whitespace-only prompt" row cites D3, but D3 decides nothing about it

Behaviour table (Zone B):

> | Empty or whitespace-only prompt | no validation layer exists this
> milestone: it is admitted like any other prompt, gets a turn id, and the
> adapter answers normally | D3 |

D3's full Decision text (the only place D3 is *decided*, and the only place
carrying its `*Enforced:*` line) is entirely about the four-event vocabulary
and which SDK events the mapping drops:

> Turn started, text delta, turn ended, error. Every accepted turn emits
> started, then zero or more deltas, then exactly one terminal event — an
> immediate failure is started, then error. Tool, compaction and retry events
> are dropped by the mapping: tools are off at the session (D11), while
> compaction and retries stay the SDK's own business.
> *Enforced:* `toPortEvent` in the SDK adapter (Contracts).

Nothing here says anything about prompt validation, empty input, or what
"accepted" means for an empty string. The row's invariant does not trace to a
Decision that classifies it on an `*Enforced:*` line — it traces to a Decision
about a different subject.

This also contradicts `evidence.md`'s own account of the fix: the "revision
pass" log claims the row was corrected to cite D3 "whose text establishes
exactly that rule." Re-reading D3's text (both in the current document and as
quoted above) shows no such rule. Either the evidence's claim about the fix is
wrong, or the row should cite a genuinely-decided rule (there isn't one — this
looks like an honest "nothing decided this" case that should say so, not cite
D3).

**Why it matters:** a builder skimming the Decision column would believe input
validation policy was settled under D3 and go looking there for the rationale;
it isn't there.

### B2 — Reload/close/quit session-disposal is asserted three places but decided nowhere

The claim that a window reload/close or app quit disposes the SDK adapter's
in-flight session (stopping work, releasing the single-flight guard) appears
in three places, always tagged D6:

- Shape, Agent channel entry: "a window reload disposes the adapter's session,
  so the underlying work stops rather than running on unseen, the guard is
  released, and the remounted pane starts clean."
- Contracts: "The adapter owns the session it made: `dispose()` on window
  close, reload or app quit, which is also what releases the single-flight
  guard (D6)."
- Behaviour table: "Window reloads mid-turn" → "main disposes the turn,
  releases the guard and stops sending..." (D6); "Window closed or app quits
  mid-turn" → "same disposal path; the SDK session is disposed so a paid
  request is not left running" (D6).

D6's own Decision text (the only place D6 is decided, carrying its
`*Enforced:*` line) is entirely about single-flight refusal and turn-id
correlation:

> `agent:prompt` returns a turn id and events come back tagged with it; the
> pane disables send while a turn is live, and a prompt that arrives mid-turn
> anyway is refused as the new turn's terminal error while the live turn runs
> on.
> *Enforced:* the single-flight guard in main's `agent:prompt` handler.

It says nothing about window lifecycle, reload, close, or app quit disposing a
session. No other Decision (D1–D12) mentions reload/close/quit disposal
either — checked by grep across the whole document; the only hits outside
Shape/Contracts/Behaviour-table are the Build-order slice-7 mention of
"disposal on window close" as a build task, not a decision.

**Why it matters:** whether an in-flight, potentially paid SDK session is torn
down on reload/close/quit — versus left running, detached, or queued — is a
real design choice with cost and correctness consequences (D12's whole "prove
it costs one short completion" framing depends on nothing running unbilled in
the background). It is asserted as settled fact in three places without ever
having been decided in the Decisions section, which is exactly the class of
decision leakage this audit is meant to catch.

### B3 — Log durability semantics (drop-not-buffer, synchronous writes) are decided only in the Behaviour table

Two Behaviour table rows, both tagged D9:

> | Log write fails mid-session | records are dropped, not buffered; the
> failure itself is printed to stderr once | D9 |
> | App quits with records in flight | `append` writes synchronously, so
> there is nothing to flush; no exit-time buffer is kept | D9 |

D9's Decision text: "One sink with `append(record)`, built at startup, passed
everywhere, and writing one file per launch under `logs/`; the renderer writes
nothing — its console output and preload errors forward to main." Nothing
here commits to synchronous I/O, to dropping records on write failure instead
of buffering/retrying, or to having no exit-time flush buffer. These are
consequential engineering commitments — synchronous writes block the main
process's event loop on every logged event; "drop, don't buffer" accepts
silent data loss — introduced with no antecedent Decision and no
`*Enforced:*` line covering them. This is the same class of issue as B2:
invariants stated in the Zone B behaviour table that do not trace to a
Decision classifying them.

### B4 — Contracts' preload constraint contradicts the document's own Facts on file

Contracts, window-construction section:

> The preload must be one file for this to load: electron-vite isolated
> build, `externalizeDeps` off for the preload config, no `require` of
> anything outside `electron`.

Facts on file (same document, sourced from `evidence.md`'s "Electron /
electron-vite prior art", itself sourced from Electron's own `sandbox.md`):

> A sandboxed preload may only `require` `electron`, `events`, `timers`,
> `url`; multi-file CommonJS preloads do not load — evidence, same section.

These two statements about the same constraint disagree: Contracts says only
`electron` may be required; Facts on file (correctly, matching `evidence.md`'s
verbatim reading of Electron's docs) says `electron`, `events`, `timers` and
`url` are all permitted under the sandbox. Verified against `evidence.md`
directly — the `sandbox.md` summary there lists all four modules, not one.

**Why it matters:** a builder reading only the Contracts section (the part
"for implementing agents," per the document's own framing) would believe
requiring `events`, `timers`, or `url` in the preload breaks the sandboxed
load. It does not, per the document's own evidence a few hundred lines away.

---

## Minor

### M1 — D1 carries the "⚠" flag but is absent from "Where to push back"

D1, D2 and D3 are the only Decisions marked `⚠` in their headings. "Where to
push back" explicitly discusses D2 and D3 (plus A1) but never mentions D1,
closing with "Nothing else is blocked; the other open questions have their own
aligns." If `⚠` is meant to signal "this is a contested/high-stakes call worth
a reviewer's attention" (which is what "Where to push back" collects), D1 —
the document's foundational bet ("The renderer reaches agents only through the
agent port") — carries the flag without being surfaced there. Low practical
impact since D1 is still visibly flagged in the Decisions section itself, but
it is an internal inconsistency in the document's own signaling convention.

### M2 — D3's own text omits "thinking" events from the drop list

D3's Decision text: "Tool, compaction and retry events are dropped by the
mapping" — no mention of "thinking" events. The Behaviour table row ("SDK
emits tool, thinking, compaction or retry events") and Contracts'
`toPortEvent` mapping table (which correctly drops anything absent from the
table, and the evidenced `AssistantMessageEvent` union does include thinking
start/delta/end per `evidence.md`) both correctly treat thinking events as
dropped too. The actual behavior is right; D3's own prose enumeration is
incomplete, which is what makes the Behaviour table's citation slightly
imprecise rather than wrong.

### M3 — `prove:sdk`'s "within 60 seconds" timeout is undecided in Zone A

Contracts: "`prove:sdk` ... exits non-zero unless it saw `turn_started`, at
least one `text_delta`, then `turn_ended` **within 60 seconds**." D12's
Decision text says only that `prove:sdk` is a committed, human-run, opt-in
script — no timing bound. This is a low-stakes implementation parameter
(a pass/fail gate for a one-shot manual script), but technically a decision
that appears nowhere in Zone A.

### M4 — "Both flavors are agent-drivable" (Glossary delta, Launch flavor) sits oddly next to the zero-cost framing

Glossary delta: "**Launch flavor**: ... Both flavors are agent-drivable." The
document elsewhere is emphatic that agents must never need a paid call (The
bet: "an agent can launch the app... at zero cost"; Launch flavors table:
`dev:sdk` costs money; D12: `prove:sdk` "run deliberately by a human, never
part of `npm test`"). "Agent-drivable" here is defensible as "launched by the
same script shape an agent could invoke" (consistent with D5's own text: "an
agent who must remember a second script drives the wrong app") rather than
"routinely run by agents regardless of cost," but the phrase reads, on a first
pass, as if it invites agents to run the paid flavor too. Worth a wording
pass, not a design fix.

---

## Verified and consistent (spot-checked, no issues found)

- Repo inventory claims (no `package.json`, `src/`, tests, lint, tsconfig;
  `.gitignore` includes `logs/`; git remote `secondcircle/crucible`; git log
  messages) — re-verified directly against the current repo, all match.
- `@earendil-works/pi-coding-agent@0.84.2` installed globally, not importable
  from this repo — re-verified (`package.json` version, and evidence's
  `ERR_MODULE_NOT_FOUND` result is credible given no dependency is declared).
- `~/.pi/agent/auth.json` exists; `~/.pi/agent/settings.json` carries
  `packages: ["../../repos/pi-extensions"]` — re-verified directly.
- `agent-browser 0.34.0` installed — re-verified directly.
- Node `v25.9.0`, npm `11.12.1` — re-verified directly.
- `CreateAgentSessionOptions` field names (`sessionManager`, `settingsManager`,
  `model`, `noTools`, `agentDir`, etc.) and documented defaults, `getBuiltinModel`
  vs deprecated `getModel`, `claude-fable-5` in the built-in catalog — all match
  `evidence.md`'s "revision pass" verbatim readings; the `createSdkAdapter` code
  snippet in Contracts uses only real field/static names.
- `toPortEvent` mapping table entries (`turn_start`, `message_update` +
  `assistantMessageEvent.text_delta`, `turn_end`, thrown/`error` events) match
  the `AgentEvent` / `AssistantMessageEvent` shapes recorded in `evidence.md`.
- `ipcMain.handle` error serialization to `{ message }` only, and the
  narrow-subscribe warning for `ipcRenderer.on`, match `evidence.md`'s IPC
  patterns section.
- `webContents` `console-message` fields (`message`, `level`, `lineNumber`,
  `sourceId`, `frame`) and `preload-error` match `evidence.md` exactly (this
  was itself a fix from a prior audit pass per `evidence.md`, and it holds).
- The `--remote-debugging-port=port` Electron doc quote, the
  `app.commandLine.appendSwitch(...)` example, and "Electron documents no
  companion address switch" all match `evidence.md`'s "revision pass 2" B2
  findings verbatim.
- Sole-`BrowserWindow` claim under D2 (Behaviour table row "Second window
  opened") matches `evidence.md`'s account of the fix and is a reasonable
  reading (nothing in this milestone's scope creates a second window path).
- Log record's four fixed fields (`ts`, `seq`, `source`, `turnId`) match "Where
  to push back"'s "left open deliberately: the log record's fields past
  timestamp, sequence, source, turn id" and `evidence.md`'s B1 fix account.
- `## Not doing` section: none of its six bullets are contradicted by an
  active Decision. The one item that *is* refused at runtime (overlapping
  prompts) is correctly pulled out of the fence list into its own sentence
  citing D6, which is the documented promotion path per `evidence.md`'s
  account of the prior audit's fix — and this is the only place in the
  document where a fence-like item is instead classified as a Decision, so
  there's no leftover contradiction between "Not doing" and any Decision.
- Choke-point names in every Decision's `*Enforced:*` line (`createMainWindow`,
  `toPortEvent`, `mountApp`, `selectAdapter`, `agent:prompt` handler,
  `contextBridge.exposeInMainWorld`, `withLogging`, `append`,
  `createSdkAdapter`, the renderer import fence) each appear by that name in
  Shape or Contracts — checked individually; no orphaned choke-point name
  found.

---

## Summary

Four blocking issues, all of the same underlying shape the audit was asked to
catch: an invariant is stated confidently in Shape, Contracts, or the
Behaviour table and tagged with a Decision letter, but the cited Decision's
own text (the only place carrying its `*Enforced:*` line) does not establish
that invariant — or, in one case (B4), directly contradicts a fact stated
elsewhere in the same document. None of these are external-fact errors; the
document's research claims against `evidence.md` and the repo held up well
under direct re-verification. Four minor issues are cosmetic or low-stakes
wording/enumeration gaps not worth a revision cycle on their own.
