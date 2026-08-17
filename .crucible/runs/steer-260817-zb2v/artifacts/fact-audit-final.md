# fact-audit-final — terminal verification pass

Run: `steer-260817-zb2v`. This is the terminal audit after the fix-only round
(fact-audit-3, recorded in `evidence.md` under "final fix-only pass"). No
further revision follows this pass; the verdict below is what gets recorded.

## Method

- Read `steering-doc.md` and `evidence.md` in full.
- Re-derived the document's own self-reported metrics (Zone A nonblank-line
  count, word counts, Zone B nonblank-line count) with the same logic as
  `lintSteeringDoc` in `pi-extensions/crucible/workflows/steer.ts`, rather
  than trusting the document's or evidence file's arithmetic.
- Independently re-ran the repo-state checks evidence.md claims (`git log`,
  `git remote -v`, `.gitignore`, `ls -a`, absence of `package.json`/`src/`).
- Read the installed π SDK's `.d.ts` files directly (`sdk.d.ts`,
  `settings-manager.d.ts`, `session-manager.d.ts`, `pi-ai/dist/compat.d.ts`,
  `pi-ai/dist/providers/all.d.ts`, `pi-ai/dist/types.d.ts`,
  `pi-agent-core/dist/types.d.ts`, `modes/json-event.d.ts`) rather than only
  trusting evidence.md's transcription of them, to check the Contracts
  section's SDK-adapter snippet and `toPortEvent` mapping table against the
  real type surface.
- Read `~/.pi/agent/settings.json` and confirmed `~/.pi/agent/auth.json`'s
  existence/permissions directly.
- Read `AGENTS.md`, `CONTEXT.md`, `docs/adr/0001-...md`, and
  `.crucible/align/260817-electron-boilerplate.md` to cross-check glossary
  and constraint claims.
- Read the format file (`pi-extensions/crucible/prompts/steer/*.md`) to get
  the precise, load-bearing definitions of `⚠`, `*Reversal cost:*`, and the
  invariant-traceability rule, rather than inferring them from the document
  alone.
- Traced every `*Enforced:*` line's named choke point into Shape/Contracts by
  grep, and every Decision (D1–D12) for orphan or contradictory references.
- Walked the Shape section, the Zone B behaviour table, Contracts, Build
  order, Facts on file, and Not doing line by line for (a) factual accuracy
  against evidence/primary sources, (b) traceability of every invariant to a
  Decision classifying it, (c) Zone B decisions absent from Zone A.

External web sources evidence.md cites (Electron docs, electron-vite docs,
GitHub raw content) were not re-fetched — no network tool is available here.
Where a claim rests solely on such a fetch, I record that it is taken on
evidence.md's word, not independently re-verified in this pass.

## What was re-verified directly (not just cross-read against evidence.md)

All of the following check out exactly as claimed, verified against the repo
or the installed package on disk, independent of evidence.md's transcription:

- `.git` exists (evidence's later passes correctly show `git init` happened,
  contradicting the first pass's `fatal: not a git repository`); no
  `package.json`, no `src/`, no `node_modules/`. `.gitignore` contains
  `logs/`. `git remote -v` → `https://github.com/secondcircle/crucible.git`.
  Matches Facts on file.
- `~/.pi/agent/settings.json` has `defaultProvider: "anthropic"`,
  `defaultModel: "claude-fable-5"`, `packages: ["../../repos/pi-extensions"]`
  verbatim. `~/.pi/agent/auth.json` exists, mode `0600`. Matches D11 and
  Facts on file exactly.
- `CreateAgentSessionOptions` in the installed SDK's `sdk.d.ts` has exactly
  the fields the Contracts snippet and Facts on file claim (`cwd`,
  `agentDir` — default `~/.pi/agent`, `modelRuntime` — default resolves
  `agentDir/auth.json` and `models.json`, `model`, `thinkingLevel`,
  `scopedModels`, `noTools: "all" | "builtin"`, `tools`, `sessionManager`,
  `settingsManager`, ...). `SettingsManager.inMemory` and
  `SessionManager.inMemory` exist as statics.
- `getModel` in `pi-ai/dist/compat.d.ts` is `@deprecated` with exactly the
  cited replacement text; `getBuiltinModel` exists in `providers/all.d.ts`;
  `claude-fable-5` is a real key in the built-in anthropic catalog JSON.
- `AgentEvent`'s type union in `pi-agent-core/dist/types.d.ts` contains
  `turn_start`, `turn_end`, `message_update` exactly as the `toPortEvent`
  mapping table assumes; `AssistantMessageEvent` in `pi-ai/dist/types.d.ts`
  contains `text_delta` (with `delta: string`) and `error` variants exactly
  as the mapping and Facts on file describe.
- `json-event.d.ts`'s `toJsonEvent` strips `partial` from streaming events,
  with the exact "cumulative assistant snapshots" doc comment evidence.md
  quotes.
- The document's own size self-report — "Reviewer path: 199 lines, as the
  format's lint counts them" — matches a from-scratch recount using
  `lintSteeringDoc`'s exact `splitZones`/nonblank-line logic: 199 nonblank
  Zone A lines, 2272 words, 304 nonblank Zone B lines. All three numbers also
  match evidence.md's own final tally ("Zone A 199 nonblank lines, 2272
  words; Zone B 304"), so the document's self-report and evidence's audit
  trail agree with a ground-up recount, not just with each other.
- Mechanical lint invariants (fence count ≤ 2 with none >12 lines, `⚠`
  present, ≥3 `*Instead of:*` lines, exactly one `*Enforced:*` line per
  Decision block, required section headings present, `draft` in the header)
  all hold on direct recomputation.
- `CONTEXT.md`, `AGENTS.md`, and ADR 0001 match the document's Facts on file
  and glossary claims; the Glossary delta's four new terms don't collide
  with any existing `CONTEXT.md` entry.

No factual claim I checked against a primary, locally-readable source
(SDK `.d.ts` files, repo git state, `~/.pi/agent/*`, `CONTEXT.md`, `AGENTS.md`,
ADR 0001, the align brief) was wrong.

## Findings

### Blocking

1. **A Zone B behaviour-table row asserts an implementation decision
   (a specific log level) that Zone A never makes, tagged to a Decision that
   doesn't cover it, and directly contradicted by Zone B's own disclaimer
   elsewhere in the same document.**

   Location: `## Behaviour and edge cases`, row "SDK emits tool, thinking,
   compaction or retry events":

   > `toPortEvent` returns nothing; the event is logged at `debug` and
   > dropped | D3

   D3 ("The port speaks four Crucible-owned events, each with a turn id")
   decides the four-event vocabulary and what `toPortEvent` drops. Its body
   says nothing about logging or log levels at all — logging is D8's
   territory, and neither D8 nor D9 decides a level scheme either. Worse,
   Contracts' own "Log record" section, two pages later in the same
   document, states explicitly:

   > What the rest of each record must convey comes from D8 — which adapter
   > answered, the prompt, each event, each error — but **the field names,
   > levels and nesting are the implementer's to choose** against the DoD 6
   > bar...

   So the document simultaneously says "log levels are undecided, pick them
   at implementation" and asserts, in the very next section down, that one
   specific category of dropped event is logged at a specific level
   (`debug`) — under a Decision tag (D3) that has nothing to do with
   logging. This is exactly the class of leakage the earlier revision passes
   caught and fixed for the log-record schema generally (fact-audit-2's B1:
   "Contracts decided a log schema Zone A calls open") and for the
   `CRUCIBLE_AGENT`-unrecognized log level specifically (fact-audit-2's M4:
   "the unstated log level is gone"). This one instance survived that
   cleanup. A builder reading only Contracts would believe the level scheme
   is theirs to design; a builder reading only the behaviour table would
   build a `debug` level into the log sink as if it were specified. Fix: cut
   "and logged at `debug`" from the row (D3 already fully explains the
   dropping — "the event is logged at `debug` and dropped" collapses to
   "dropped"), or, if logging dropped events is meant to be a real
   commitment, give it a Decision that actually decides it.

### Minor

1. **D3 is marked `⚠` but its own `*Reversal cost:*` line says `moderate`,
   not `expensive`.** The format file (`pi-extensions/crucible/prompts/steer/`)
   defines `⚠` precisely: "⚠ marks entries whose reversal would cost days or
   invalidate merged work" — i.e., it is supposed to track the `expensive`
   reversal-cost tier, and the document's other two `⚠` entries (D1, D2) both
   correctly pair the mark with `*Reversal cost:* expensive`. D3 pairs `⚠`
   with `*Reversal cost:* moderate`, a self-contradiction within one 8-line
   block. This looks like it happened because D3 is also the subject of a
   "Where to push back" bullet ("D3 — four port events for the whole
   milestone. Too thin to grow from?") — a distinct, independent flagging
   mechanism in the format that doesn't require or imply `⚠`. Low practical
   impact: the same "look harder at D3" signal is already delivered by the
   "Where to push back" bullet, so no reviewer is likely to be misdirected,
   but the classification is internally inconsistent and mechanically
   checkable. Fix: either raise D3's reversal cost to `expensive` and justify
   it, or drop the `⚠`.

2. **Decisions are not sorted strictly by reversal cost, despite "ranked
   most-irreversible first" being one of the format's own stated
   invariants.** Actual tier sequence by Decision: D1 expensive, D2
   expensive, D3 moderate, D4 moderate, D5 cheap, D6 moderate, D7 cheap, D8
   cheap, D9 moderate, D10 moderate, D11 cheap, D12 cheap — `cheap` (D5, D7,
   D8) interleaves with `moderate` entries (D6, D9, D10) rather than all
   `moderate` entries preceding all `cheap` ones. Plausibly intentional
   (grouped by topic — launch/logging/testing — rather than by strict cost,
   with the two most expensive decisions still correctly bubbled to the top),
   but it is not a strict sort, and "ranked most-irreversible first" is
   stated as a hard property. Not worth reordering the whole list for; noting
   for completeness.

3. **`no `require` beyond ... `electron`, `events`, `timers`, `url` (plus
   their `node:` spellings)`** (Contracts, preload paragraph) adds "plus
   their `node:` spellings" — a detail evidence.md's own transcription of
   Electron's sandbox doc never states. Evidence.md's "Electron / electron-vite
   prior art" section and its restatement in "revision pass 2" both list only
   `electron, events, timers, url` (plus the `Buffer`/`process`/`setImmediate`
   globals, not modules). The `node:`-prefix claim is plausible (Node's
   `node:`-prefixed built-in aliases are broadly permitted wherever the
   bare name is) but isn't receipted anywhere in the evidence trail, and I
   had no network access in this pass to check Electron's `sandbox.md`
   directly. Flagging as an unverified addition rather than a wrong one.

## Zone B decision-leakage check (general)

Beyond finding 1 above, I walked every Contracts subsection, every Shape
paragraph, every Build-order slice, and every behaviour-table row looking for
values, thresholds, or mechanisms asserted in Zone B with no Decision behind
them at all. All of them trace cleanly:

- The `PortEvent` error-code union (`"busy" | "adapter"`) traces to D6
  (busy refusal) and D3 (adapter-mapped SDK failure) respectively, and both
  values are used consistently everywhere they appear.
- The SDK-adapter construction snippet, `toPortEvent`'s mapping table, and
  the pre-prompt-vs-mid-stream failure split all sit under a "(D3, D11)"
  heading and elaborate those two Decisions without adding new ones (the
  option names were independently re-verified against the SDK's `.d.ts`
  above).
- The fake adapter's script/cadence contract (exported constants, zero-pause
  in tests) sits under "(D4, ...)" and elaborates D4 without introducing new
  commitments.
- `prove:sdk`'s pass criterion (turn_started → ≥1 text_delta → turn_ended
  within 60s) sits under "(D12)" and is a direct operationalization of D12's
  "proven against the real SDK once," not a new decision.
- The Agent Browser recipe, the renderer import fence, and the launch-flavor
  table are each headed with explicit Decision citations (D5; D1, D4; D5)
  and stay within them.
- The log-record JSON fence keeps to exactly the four fields "Where to push
  back" says are settled (`ts`, `seq`, `source`, `turnId`), matching A6 and
  the "left open deliberately" line — this is the fix from the earlier
  fact-audit-2 pass (B1) holding correctly.

The one exception is the `debug`-level detail in finding 1 above.

## Invariant-traceability check (Shape, Done looks like, behaviour table)

Every `*Enforced:*` line's choke point was checked against Shape/Contracts by
name and all twelve resolve:

| Decision | Enforced choke point | Found by that name in |
| --- | --- | --- |
| D1 | the renderer import fence | Contracts |
| D2 | `createMainWindow` | Contracts |
| D3 | `toPortEvent` | Contracts |
| D4 | `mountApp` | Shape (chat pane entry) |
| D5 | `selectAdapter` | Contracts |
| D6 | main's `agent:prompt` handler (single-flight guard) | Shape (agent port entry) |
| D7 | preload's `contextBridge.exposeInMainWorld` | Contracts |
| D8 | `withLogging` | Shape (end-to-end walkthrough) |
| D9 | the log sink's `append` | Shape (log sink entry), Contracts |
| D10 | stated, not enforced | (literal, no name to check) |
| D11 | `createSdkAdapter`'s in-memory session construction | Contracts |
| D12 | stated, not enforced | (literal, no name to check) |

Every Shape interface-prose claim, every Done-looks-like bullet, and every
behaviour-table row (except the `debug`-level fragment in finding 1, and the
"Empty or whitespace-only prompt" row, which correctly carries `none` and
asserts nothing) traces to the Decision named in its row or paragraph. The
"Empty or whitespace-only prompt" row is a genuine fix holding from the prior
fix-only pass (fact-audit-3's B1): it now states only that no Decision
governs the case, and carries no invariant of its own.

## `## Not doing` vs Decisions

The section's own preamble ("Everything here is a scope fence: not built,
nothing refuses it at runtime") is not contradicted by any of its six
bullets on this pass. The one item that *is* refused at runtime — overlapping
prompts — has already been pulled out of the fence list into its own line
("Refused at runtime rather than absent, hence a Decision not a fence:
overlapping prompts (D6)"), which is the fix from fact-audit-1's original
blocking finding holding correctly. Checked each remaining bullet against
every Decision's body for a contradiction (an active runtime refusal
described as merely "not built"):

- Packaging/auto-update/CI, styling/design, multi-turn history/sessions/model
  picker, legacy-system carryover — no Decision claims any runtime behavior
  for these; clean fences.
- Browser E2E/Playwright component tests — D10 only says these are the
  alternative not chosen ("Instead of: Playwright component testing in a
  real browser") and "stated, not enforced"; nothing refuses running them at
  runtime. Clean fence, correctly cited.
- Login/logout UI — D11 only decides credential inheritance, not login UI
  behavior. Clean fence.

No contradiction found in this pass.

## Summary

Three prior fact-audit rounds already found and fixed four blocking issues
each (contradicted "Not doing" fence, a decision-stamped empty-prompt row, an
over-specified log schema, an uncited loopback-binding claim, session
disposal and log-failure policy mistagged to the wrong Decision, and a wrong
preload `require` whitelist). All of those fixes hold on this terminal pass:
independent re-derivation of every factual claim I could check against a
primary source (SDK `.d.ts` files, repo git state, `~/.pi/agent/*`,
`CONTEXT.md`/`AGENTS.md`/ADR 0001, the align brief, and the document's own
mechanical-lint numbers) came back correct. One narrow instance of the same
class of leakage the earlier rounds were fixing — a specific log level
asserted for one behaviour-table row, tagged to a Decision that doesn't
decide it, contradicting an explicit "implementer's to choose" disclaimer
seven lines away in the same section — survived the fix-only round and is
reported blocking above. Two cosmetic inconsistencies (a `⚠` marker at odds
with its own stated reversal cost; an uncited technical detail about `node:`
module-spelling aliases in the preload whitelist) and one soft ordering
observation are reported minor.
