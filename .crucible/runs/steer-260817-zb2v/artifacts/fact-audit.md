# Fact audit — Crucible Electron boilerplate steering document

Audited: `steering-doc.md` against `evidence.md`'s receipts, and directly
against the repo / installed packages / primary sources where reproducible
without network access. Zone A = lines 1–244 (Bet → Done looks like, ending
at "End of the reviewer path"). Zone B = everything from `## Contracts`
onward.

## Method

- Re-ran every repo-state command evidence.md reports (`ls`, `git log`,
  `git remote -v`, `gh repo view`, `cat .gitignore`, Node/SDK import probe,
  `~/.pi/agent/settings.json`, `~/.pi/agent/auth.json`) and got matching
  results.
- Read the installed `@earendil-works/pi-coding-agent@0.84.2` type
  declarations and `docs/sdk.md` directly (`agent-session.d.ts` equivalent
  prose, `json-event.d.ts`, `pi-ai/dist/types.d.ts`) to confirm the SDK-surface
  claims independently of evidence.md's paraphrase.
- Traced every `*Enforced:*` line in Decisions D1–D12 to the choke-point name
  it cites and checked whether that name appears in `## Shape` and/or
  `## Contracts`.
- Traced every row of the Zone B behaviour table and every `## Not doing`
  bullet back to the Decision it cites, checking whether the Decision's own
  text (Zone A) actually establishes the behaviour, or whether Zone B is
  inventing a new rule under an unrelated Decision's name.
- Checked `## Not doing`'s preamble ("nothing refuses it at runtime")
  against its own bullets and the Decisions they cite.

## Findings — blocking

1. **`## Not doing` contradicts its own scope-fence claim, using a Decision's
   own words.** (steering-doc.md, `## Not doing`, line ~216 preamble vs. the
   bullet "Abort, steer, follow-up while streaming — refused instead (D6)".)
   The section header states as its governing rule: "Everything here is a
   scope fence: not built, nothing refuses it at runtime." The very next
   bullet says these are "**refused instead**" — the same verb the preamble
   just used to disclaim. D6's own text confirms this is a real runtime
   mechanism, not a scope note: "a prompt arriving mid-turn is refused as the
   new turn's terminal error," enforced by "the single-flight guard in main's
   `agent:prompt` handler," and restated in the Zone B behaviour table
   ("new turn id minted, then a single `error` event with `code: 'busy'`").
   So this "Not doing" entry is contradicted by its own cited Decision: D6
   *does* refuse the behaviour at runtime; "Not doing" claims nothing does. A
   builder reading only the reviewer path (Zone A) would reasonably conclude
   abort/steer is simply absent rather than actively rejected with a specific
   error code — the opposite of what D6 and the behaviour table say. This is
   exactly the class of gap the audit brief calls out by name.

2. **Zone B behaviour-table row invents a rule not decided anywhere in Zone A,
   then misattributes it to D6.** (steering-doc.md, `## Behaviour and edge
   cases`, row "Empty or whitespace-only prompt | the pane does not call the
   port; no turn id, no log record | D6".) D6 ("One turn at a time, correlated
   by turn id") is entirely about turn concurrency and the single-flight
   guard in main; nothing in D6's text, `*Because:*`, or `*Enforced:*` line
   touches client-side input validation. No other Decision (D1–D12), no line
   in `## Shape`, and no line in `## Done looks like` establishes that the
   chat pane validates/trims/rejects empty input before calling the port.
   This is a new decision — "the pane must not call the port for
   empty/whitespace-only text" — introduced for the first time in the Zone B
   table and stamped with an existing Decision's name it does not belong to.
   Per the audit's own rule ("elaboration is fine; new decisions are
   leakage"), this is leakage: a builder implementing strictly from Zone A
   would never know this validation is required, and a builder trusting the
   "D6" citation would look in the wrong place for the rationale.

## Findings — minor

3. **Two `*Enforced:* … (Contracts)` citations point to names that are not
   actually in the Contracts section.** D3's line reads `*Enforced:*
   \`toPortEvent\` in the SDK adapter (Contracts).` and D11's reads
   `*Enforced:* \`createSdkAdapter\`'s in-memory session construction
   (Contracts).` Neither `toPortEvent` nor `createSdkAdapter` appears in
   `## Contracts` (verified by grep across the whole document); both names
   appear only in `## Shape`'s "SDK adapter" entry (`Hidden behind it:
   createSdkAdapter's in-memory session and settings with tools off,
   createAgentSession/prompt/subscribe, and toPortEvent, …`). The audit's
   traceability rule ("names one that appears by that name in Shape or
   Contracts") is technically satisfied — both names do appear in Shape — so
   this is not blocking, but the parenthetical `(Contracts)` is a wrong
   pointer: a builder following it to the Contracts section to find
   `toPortEvent`'s or `createSdkAdapter`'s shape will not find either there,
   only in prose in Shape.

4. **`## Not doing`'s "Tool calls, thinking, compaction, retries in the port
   — dropped by the mapping (D3)" bullet is in mild tension with the same
   preamble** ("nothing refuses it at runtime"). The behaviour table confirms
   this is active runtime behaviour, not mere absence: "`toPortEvent` returns
   nothing; the event is logged at `debug` and dropped." Filtering/dropping
   at a mapping boundary is weaker than "refusing" a request (nothing is
   rejected; the port simply never had a case for these SDK event types), so
   this reads more defensibly as "not built" than #1 above does, but it is
   the same shape of tension and worth a wording pass if #1 is fixed.

5. **Behaviour-table row "`CRUCIBLE_AGENT` unset, empty or unrecognized …
   one `warn` record when the value was set but unrecognized | D5"** adds a
   specific logging behaviour (a `warn` record on unrecognized env values)
   that D5's own text doesn't mention (D5 only says "unset means fake").
   This is a plausible elaboration of D5 (env selection) combined with D8
   (logging), not clearly a new decision, but it isn't strictly derivable
   from either Decision's text alone — flagged for awareness, not blocking.

6. **"Facts on file" bullet on `webContents` hooks says "`console-message`
   (with level and source)"** — evidence.md's own fetch of Electron's
   `web-contents.md` records the actual event parameters as `message`,
   `level`, `lineNumber`, **`sourceId`**, `frame` — there is no parameter
   literally named `source`. The steering doc's "source" likely means
   "source of the message" informally, but read as a field name it doesn't
   match the primary doc evidence.md itself cites. Low risk (the Contracts
   log-record schema separately and correctly uses its own `source` field
   for `main`/`renderer`/`agent-port`, which is unrelated and not confused by
   this), but worth a one-word fix if precision matters here.

## Findings — verified correct (no issue; recorded for completeness)

Cross-checked directly against the repo and installed packages (not just
evidence.md's word) and found accurate:

- No `package.json`, `.git` history, `src/`, tests, lint, or tsconfig prior to
  this run's own residue; only `.crucible/`, `.firecrawl/`, `AGENTS.md`,
  `CONTEXT.md`, `docs/` exist, matching "Facts on file" bullet 1.
- `git log --oneline -n 5`, `git remote -v`, `cat .gitignore` reproduce
  exactly what evidence.md and the steering doc's "Facts on file" bullet 2
  claim: two commits dated 2026-08-17, `origin` =
  `https://github.com/secondcircle/crucible.git`, `.gitignore` includes
  `logs/`.
- `gh repo view secondcircle/crucible --json name,visibility,defaultBranchRef`
  reproduces `{"defaultBranchRef":{"name":"main"},"visibility":"PRIVATE"}`
  independently.
- `@earendil-works/pi-coding-agent` is installed globally at version `0.84.2`
  (`package.json` read directly) and fails to import from this repo with
  `ERR_MODULE_NOT_FOUND`, reproduced directly with
  `node --input-type=module -e "import {...} from '@earendil-works/pi-coding-agent'"`.
- `~/.pi/agent/settings.json` contains `packages:
  ["../../repos/pi-extensions"]` exactly as quoted; `~/.pi/agent/auth.json`
  exists.
- `docs/sdk.md` confirms, verbatim in spirit: `prompt()` is documented "Send
  a prompt and wait for completion," and "During streaming without
  `streamingBehavior`: Throws an error" — matching the steering doc's "Facts
  on file" claim about `prompt()` resolving only at end of turn and throwing
  mid-stream without `streamingBehavior`.
- `dist/modes/json-event.d.ts` confirms verbatim the claim that the SDK's
  JSON/RPC wire form strips the cumulative `partial` snapshot from
  `message_update` events (`WithoutPartial<T>`, and the doc comment "Remove
  cumulative assistant snapshots from streaming wire events").
- `pi-ai/dist/types.d.ts` confirms a `text_delta` event type exists in the
  assistant-message event union, consistent with the nested
  `message_update → assistantMessageEvent.type === "text_delta" → .delta`
  claim.
- Node `v25.9.0`, `agent-browser 0.34.0`, and `electron-vite@5.0.0`'s engines
  field (`^20.19.0 || >=22.12.0`) all reproduce exactly as cited.
- The document's own "Reviewer path: 197 lines" claim is exactly correct:
  counting nonblank lines from the top of the document through the line
  before "**End of the reviewer path.**" yields exactly 197.
- `CONTEXT.md`'s existing glossary entries for **Crucible**, **legacy
  system**, **agent port**, **fake adapter**, **SDK adapter** match the
  steering document's Shape/Glossary-delta language closely (near-verbatim
  in places), so the "Glossary delta" section is consistent elaboration, not
  a re-definition or drift.
- Build order (slices 1–7) and Glossary delta introduce no choke points,
  file names, or behaviours beyond what Decisions D1–D12, Shape, and
  Contracts already establish; every item there is traceable elaboration
  (scaffolding steps, blocking order, term restatement), not new decisions.
- All ten remaining `*Enforced:*` choke-point names (D1 renderer import
  fence, D2 `createMainWindow`'s `webPreferences`, D5 `selectAdapter`, D6
  single-flight guard, D7 `contextBridge.exposeInMainWorld`, D8 `withLogging`,
  D9 log sink `append`) appear by that exact name in `## Shape` and/or
  `## Contracts`, and where a Decision cites "(Contracts)" outside of
  finding #3 above, the name is genuinely present there.
- Remaining behaviour-table rows (busy-turn refusal, SDK-throw mapping to
  `code: "adapter"`, tool/thinking/compaction/retry dropping, `ipcMain.handle`
  serialization limits, window-reload mid-turn, logs/ missing at startup,
  renderer console/preload-error forwarding, renderer uncaught exceptions,
  log-write failure, component-test mounting, `npm test` with credentials
  present, concurrent fake-adapter use) all trace consistently to the
  Decision they cite as either a direct restatement or a defensible
  elaboration of that Decision's stated mechanism.

## Verdict summary

Two blocking issues: a direct textual contradiction inside `## Not doing`
between its scope-fence preamble and the D6-sourced "refused instead" bullet,
and one Zone B behaviour-table row (empty/whitespace prompt handling) that
introduces a decision with no basis anywhere in Zone A while citing D6, which
does not cover it. Four minor issues: two `(Contracts)` citations pointing to
names that only exist in Shape, a softer echo of the Not-doing/preamble
tension on the tool/thinking/compaction/retry bullet, an under-specified
`warn`-record behaviour tacked onto D5, and one imprecise field name
("source" vs. the primary doc's "sourceId") in the Facts-on-file section.
Every other claim checked — repository state, git/GitHub state, SDK type
surface, Electron/electron-vite prior art, Agent Browser and environment
facts — was verified either directly against the live repo/installed
packages or matches evidence.md's own receipts exactly.
