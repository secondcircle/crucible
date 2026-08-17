# Fact audit — steering-doc.md (steer-260817-zb2v)

Auditor: fact-audit-2 (fresh-context). Scope: verify every checkable claim
against the repo, the installed SDK, primary external sources, and
evidence.md's own receipts; check Zone A/Zone B decision-leakage and the
document's own internal traceability contract (invariant → Decision with an
`*Enforced:*` line; Decision choke-point name → appears in Shape/Contracts;
`## Not doing` entries not contradicted by a Decision).

Method: read `steering-doc.md` and `evidence.md` in full; re-ran the primary
checks evidence.md describes (repo inventory, `git`/`gh`, SDK `.d.ts` files
under `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`,
`@earendil-works/pi-ai`, live fetches of the Electron docs and the
electron-vite `react-ts` playground source, `agent-browser --version` /
`skills get electron`); ran the repo's own `lintSteeringDoc` /
`splitZones` from `pi-extensions/crucible/workflows/steer.ts` against the
actual file to check the document's self-reported Zone A size.

Overall: the document's technical claims about the π SDK surface, Electron/
electron-vite behaviour, and the repo's current state are accurate — every
spot-checked fact matched the primary source exactly (SDK option names and
defaults, `getModel`/`getBuiltinModel` deprecation, `claude-fable-5` in the
catalog, sandboxed-preload `require` whitelist, `ipcMain.handle` error
serialization, `console-message` field names, the playground's
`sandbox: false` and missing `test` script, Node/electron-vite engine ranges,
`agent-browser` version and CLI workflow, repo inventory, `.gitignore`
contents). The problems found are structural: one clear case of Zone B
deciding something Zone A explicitly declares undecided, one uncited/
unverified factual claim presented as settled, and several small labelling/
number inconsistencies.

---

## Blocking

### B1 — The Contracts log-record schema contradicts "Where to push back" / A6, which say those fields are undecided

- **Location:** "Where to push back" (line 24) vs "Contracts → Log record"
  (lines 364–377) vs Assumptions table row A6 (line 214).
- **Claim in Zone A:** "Left open deliberately: the log record's fields past
  timestamp, sequence, source and turn id — settled at implementation, behind
  the sink, where it stays cheap." Assumption A6: "The log schema can be
  settled at implementation | rework confined behind the log sink | write one
  session's log and read it back."
- **What Zone B actually does:** Contracts presents a fully-specified example
  record —
  `{"ts":...,"seq":17,"source":"main","level":"info","event":"agent.event","turnId":"t-3","adapter":"fake","msg":"text_delta","data":{"delta":"Hel"}}`
  — under the heading "Log record, one JSON object per line (D8, D9)", then
  states "`source` is `main`, `renderer` or `agent-port`" (a specific,
  closed enum, introduced nowhere else in the document — `grep`-verified,
  only occurrence of `agent-port` as a source value is this line) and closes
  with "Fields beyond these are open (A6)". That sentence only makes sense if
  the nine fields already shown (`ts`, `seq`, `source`, `level`, `event`,
  `turnId`, `adapter`, `msg`, `data`) are treated as decided — which directly
  contradicts the "Where to push back" line's claim that only four of those
  nine (`ts`, `seq`, `source`, `turnId`) are settled and the rest await
  implementation.
- **Why it matters:** this is exactly the leakage the document's own contract
  forbids — Zone B (Contracts) makes an architectural decision (the record's
  field names, their types, and a closed `source` enum including a value,
  `"agent-port"`, that appears nowhere else) that Zone A explicitly disclaims
  making. A reviewer who only reads the reviewer path (Zone A, as the
  document's own front matter instructs on a rewrite: "Do not promote
  material from below this line") would believe the schema is open; a builder
  who reads Contracts would implement it as fixed. Neither D8 nor D9's
  Decision text names `level`, `event`, `msg`, `data`, or the `agent-port`
  source value — there is no Decision this schema traces to, and the section
  that does address it (A6, "Where to push back") says the opposite.

### B2 — "the switch binds loopback only" is an uncited, unverified security claim presented as settled fact

- **Location:** Contracts → Agent Browser recipe (line 361): "Port 9222 is
  fixed and documented in `AGENTS.md`; the switch binds loopback only and
  exists in dev alone, since this run ships no packaged build."
- **Checked:** evidence.md's "Agent Browser" and "Electron / electron-vite
  prior art" sections (its full source list) never mention loopback binding
  for `--remote-debugging-port`; neither does any UNVERIFIED row, any
  Assumption, or the "Facts on file" list. `grep` across both files confirms
  this phrase appears exactly once, in Contracts, with no citation.
- **Why it matters:** this is a security-relevant claim (whether the CDP
  debug port is reachable off-machine) stated as settled fact in the
  document's normative Contracts section, with no evidence trail — unlike A1
  (the sibling claim about whether the flag reaches Chromium at all), which
  the document correctly carries as an open assumption with its own
  UNVERIFIED row and a one-shot check. A builder reading Contracts has no
  signal that this specific detail was asserted rather than checked, and
  might skip verifying it precisely because it reads as settled.

---

## Minor

### M1 — Zone A line/word count does not match the document's own lint tool

- **Location:** "Reviewer path: 197 lines." (line 6, Zone A front matter);
  evidence.md's "draft pass" and "revision pass" notes both report "Zone A
  197 nonblank lines, 2200 words."
- **Checked:** ran `splitZones`/the nonblank/word counters from
  `pi-extensions/crucible/workflows/steer.ts` (the same tool evidence.md says
  it used) directly against the current `steering-doc.md`. Result: **198**
  nonblank lines, **2212** words in Zone A. `lintSteeringDoc` still reports no
  problems (the cap is 200), so this doesn't break the format, but the
  self-reported number in the document and in evidence.md's revision-pass
  note is off by one line / twelve words from what the file actually
  measures now — most likely a small post-measurement edit that was never
  re-counted.

### M2 — A1 is quoted with two different flag spellings for the same claim

- **Location:** "Where to push back" (line 22): `` `--remote-debugging-port 9222` `` (space, no `=`).
  Assumptions table (line 209), UNVERIFIED table (line 547), and elsewhere
  (lines 538, 552): `` `--remote-debugging-port=9222` `` / `` `--remote-debugging-port` ``.
- The Agent Browser skill (verified live via `agent-browser skills get
  electron`) and Chromium's own flag syntax use `=`. The "Where to push
  back" occurrence is the only place in the document missing it — cosmetic,
  same claim (A1), not a different assumption.

### M3 — "HMR" in "Done looks like" has no Decision to trace to

- **Location:** "Done looks like" bullet 1 (line 232): "`npm run dev` opens
  the app with HMR, renderer sandboxed."
- "renderer sandboxed" traces cleanly to D2 (`Enforced: createMainWindow's
  webPreferences`). "HMR" does not trace to any Decision — it is not
  mentioned in any of D1–D12, only once elsewhere in the Prior-art table as a
  citation of electron-vite's own docs. Per the document's stated contract
  ("every invariant stated anywhere ... traces to a Decision that classifies
  it on an `*Enforced:*` line"), this is a small gap: nobody decided HMR is
  in scope, it is simply assumed to come free with the named toolchain
  ("The bet" prose, not a Decision). Low stakes — HMR is default electron-vite
  behaviour, not a Crucible design choice — but it is a literal contract gap.

### M4 — "Malformed IPC payload" row's specific handling isn't in D6's text

- **Location:** Behaviour table (line 417): "Malformed IPC payload
  (non-string prompt) | the handler answers with a terminal `error`, never a
  throw, and logs the payload's shape | D6".
- D6's Decision text (single-flight, turn-id correlation, busy refusal) never
  discusses input-type validation. The specific rule here (never throw, log
  the payload's shape) is new content that appears only in this table row —
  a reasonable extrapolation of the general "the handler never throws"
  pattern established for the busy case, but the type-validation scenario
  itself isn't decided anywhere in Zone A. Same class of gap as M3, smaller
  stakes since it's a defensive-programming default rather than an
  architectural choice.

### M5 — "Second window opened" is tagged D6 but the underlying fact is D2's

- **Location:** Behaviour table (line 420): "Second window opened | out of
  scope this milestone: the handler serves the sender's `webContents` only |
  D6".
- The reason a second window is out of scope is that `createMainWindow` is
  "the sole `BrowserWindow`" — that's D2's territory (Contracts: "Window
  construction — `createMainWindow`, the sole `BrowserWindow` (D2)"), not
  D6's (single-flight turn correlation). The row's content is plausible
  either way, but the Decision attribution is imprecise — a builder tracing
  "why is multi-window out of scope" from this row lands on the wrong
  Decision.

---

## What checked out cleanly (for context, not findings)

- Repo inventory (`git log`, `git remote -v`, `.gitignore` contents, absence
  of `package.json`/`src`/tests) — matches "Facts on file" and evidence.md
  exactly, re-verified independently.
- `docs/adr/0001-...md`, `CONTEXT.md`, `AGENTS.md` — glossary terms ("agent
  port", "fake adapter", "SDK adapter", "legacy system") used consistently
  and correctly with their defined meanings.
- `CreateAgentSessionOptions` field list and documented defaults
  (`sdk.d.ts`), `SessionManager.inMemory` / `SettingsManager.inMemory`
  statics, `getModel` deprecated in favor of `getBuiltinModel` from
  `@earendil-works/pi-ai/providers/all` (confirmed via the package's
  `exports` map), `claude-fable-5` present in the built-in anthropic catalog
  — all verbatim-verified against the installed package's `.d.ts` files and
  JSON catalog.
- `AgentSession.prompt()` returns `Promise<void>` and throws when streaming
  without `streamingBehavior`; `AgentEvent`/`AssistantMessageEvent` nesting
  (`message_update` → `assistantMessageEvent.type === "text_delta"` →
  `.delta`) — confirmed against `agent-session.d.ts` and
  `pi-agent-core/dist/types.d.ts`.
- Electron sandboxed-preload `require` whitelist (`electron`, `events`,
  `timers`, `url` + `node:` equivalents), `ipcMain.handle` error
  serialization to `{ message }` only, `console-message` event fields
  (`message`, `level`, `lineNumber`, `sourceId`, `frame`) and its four level
  values (`info`, `warning`, `error`, `debug`) — confirmed against live
  fetches of the primary Electron docs.
- electron-vite `react-ts` playground sets `sandbox: false` explicitly and
  ships a bare `contextBridge.exposeInMainWorld('electron', electronAPI)`
  passthrough, and has no `test` script — confirmed against the live
  playground source.
- Node `v25.9.0` and engine ranges for electron-vite (`^20.19.0 ||
  >=22.12.0`) and the SDK (`>=22.19.0`); `agent-browser 0.34.0` and its
  documented `--remote-debugging-port` → `connect` → `snapshot` workflow —
  confirmed by running the tools directly.
- `~/.pi/agent/settings.json`'s `packages: ["../../repos/pi-extensions"]`
  and `defaultModel: "claude-fable-5"`, `~/.pi/agent/auth.json` existing —
  confirmed by reading the files.
- The renderer import-fence ESLint pattern's file-tree assumptions
  (`src/renderer/src/...`) match electron-vite's documented default tree.
- All twelve Decisions (D1–D12) are referenced outside their own header, and
  every Decision that names a choke point (D1 "renderer import fence", D2
  `createMainWindow`'s `webPreferences`, D3 `toPortEvent`, D4 `mountApp`, D5
  `selectAdapter`, D6 the single-flight guard / `agent:prompt`, D7
  `contextBridge.exposeInMainWorld`, D8 `withLogging`, D9 the log sink's
  `append`, D11 `createSdkAdapter`) names a choke point that appears by that
  exact name in Shape or Contracts. D10 and D12 are correctly marked "stated,
  not enforced" and name no choke point.
- The `## Not doing` section is internally consistent: no listed fence is
  contradicted by an active-refusal Decision, and the one runtime refusal
  that could be mistaken for a fence (overlapping prompts) is correctly
  called out as "a Decision and not a fence: overlapping prompts (D6)" rather
  than listed among the fences.
