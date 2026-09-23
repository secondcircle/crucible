# Rules and Jev: prototype handoff

What was explored, what was built, where it lives, and what was learned. It's a record, not a plan.

## The idea

A **rule** is something a project wants done a particular way: an ADR, a doctrine, a line in AGENTS.md. Today such rules are enforced either in code (lint, tests, the compiler) or in prose, by review agents that read them late and at great expense. The idea explored here is a middle path as a Crucible primitive. Crucible watches an agent's tool calls, and code pulls out the narrow piece a rule governs. Then a deterministic check or a cheap calibrated classifier judges it, and any violation is fed back to the agent while it works, instead of at the merge gate.

The classifier is **Jev**, TypeSafe AI's "System One" model. You send a state (text or JSON) and typed questions, and it returns calibrated probabilities with no generated text. It costs $0.042 per million input tokens, output is free, and it's in early access.

## What exists

**Built.** A standalone prototype of the authoring and testing half:
- a rule-file API;
- tree-sitter extraction;
- a real Jev client with caching and a spend cap;
- a companion test-file API;
- a runner (`test`, `explain`, `survey`);
- label mining from git history.

One real rule, **comments**, enforces Crucible's comment doctrine. It was measured against Crucible's own history with about 8,000 real Jev calls.

**Not built.** Anything in the app. There's no π hook, no live loop, no rule host process, no ledger, no feedback to a running agent, and no UI. Nothing in `src/` knows rules exist. The rule file sits at `mode: 'off'`.

## Where it lives

Branch `prototype/rules-jev`:

| Path | What |
|---|---|
| `.crucible/rules/comments.ts` | The rule: one Jev `choice` over what a new comment is doing, plus a line count in code |
| `.crucible/rules/comments.test.ts` | Its 16 scenarios: 6 extraction-only, 4 made-up judgments, 6 real comments from history |
| `prototypes/rules/src/` | The runner. `rule.ts` (the `defineRule` surface), `public.ts` + `register.ts` (resolve `crucible:rule`, `crucible:rule/extract`, `crucible:rule/test` for rule files in any repo), `extract.ts`, `syntax.ts`, `evaluate.ts` (the one pipeline), `judge.ts`, `events.ts`, `test-api.ts`, `labels.ts`, `report.ts`, `cli.ts` |
| `prototypes/rules/experiments/wording.ts` | The question-wording experiment |
| `prototypes/rules/docs/design-sketch.md` | The design as sketched: API, triggers, actions, ledger, judges, testing, the rules Crucible would run on itself |
| `prototypes/rules/docs/comments-rule-results.md` | The comments rule explained in plain terms, with a real request and response, and the measurements |
| `prototypes/rules/results/` | Survey data: the first version (three yes/no questions), the wording experiment, and the final version |
| `eslint.config.mjs` | `prototypes/**` added to the ignores; the only change outside the prototype |

Local to this machine and gitignored:
- **`prototypes/rules/local/`.** The original brainstorm and design drafts. They're built on examples from a work repository and quote its code, and this repo is public, so they're never to be committed. They also hold a snapshot of TypeSafe's agent skill and SDK types.
- **`prototypes/rules/.env`.** Holds `TYPESAFE_API_KEY`.
- **`prototypes/rules/.cache/jev/`.** About 8,000 cached answers, keyed by (model, state, questions). Re-running anything already asked is free. Without the cache, the full survey costs about $0.10 and 20 minutes.

To run it: `cd prototypes/rules && npm install`, then `node src/cli.ts test comments`, `explain comments <path:line> [--at <rev>]`, or `survey comments`. Each takes `--extract-only` for a free run with no network.

## The shape the design landed on

These points were argued through in conversation and are worth keeping:

- **One TypeScript file per rule in `.crucible/rules/`, with a companion `<name>.test.ts`.** A rule is code, because its extractor is a small static analyzer. It's versioned with the repo it governs, and it imports a Crucible-provided module the way workflows import `crucible:workflow`.
- **A rule declares:**
  - its `source` document and a `summary`;
  - a trigger (`edit`, `bash` before it runs, `commit`, or `checkpoint` at node completion or turn end);
  - its `scope` (path globs, sessions or nodes);
  - its `mode` (`off`, `shadow`, `enforce`);
  - `extract` (code), `judge` (questions as data, TypeSafe's own builders), `decide` (code over the answers) and `feedback` (the text the agent reads).
- **An empty extraction means the rule doesn't apply,** and no call is made. That's how many rules coexist without every edit paying for every rule.
- **Actions are typed by trigger,** so invalid ones can't be written. `pass`, `log`, `note`, `escalate` everywhere; `block` only before execution; `hold` only at a checkpoint.
- **Questions are data, not calls.** That lets Crucible batch questions over the same state across rules, cache, run cases offline, and swap judges per workspace.
- **One pipeline, `evaluate(rule, event)`, serves both the live hooks and the test runner.** Only the event source differs. That's what makes a passing test mean the live behaviour.
- **Test scenarios build events from the real repo without writing to it:** `edit`, `write`, `commit(sha)`, `range(base, head)`, and `existingComment(path, line, at)`, which replays any historical comment as newly added. What a scenario asserts sets how deep it runs. Asserting items stays in the extractor and is free. Asserting actions or feedback makes real Jev calls.
- **Mode `off` means never fed live events.** The idea was that the loader runs the free extraction scenarios before allowing `shadow` or `enforce`.
- **Sketched but not built:**
  - a ledger with content-derived item keys, recording "fixed" separately from "reworded";
  - a bounce cap (two notes, then escalate);
  - a long-lived rule host process on the workflow-host model;
  - per-rule time budgets, where a broken or slow rule is skipped and never breaks a turn;
  - falling back to `log` when the judge is unreachable.

## What the app already has that a real version would use

- **π's extension hooks.** `tool_call` can block with a reason, and `tool_result` can rewrite the content and `isError` the model reads next. Crucible already registers extensions through `extensionFactories` in `src/main/agent/sdk-adapter.ts` (the branch-summary and compaction extensions).
- **Steering at tool boundaries.** `session.sendCustomMessage(..., { deliverAs: 'steer' })`, used by `shareBashRun` in the same file. ADR 0031 already runs compaction at the same between-rounds point.
- **`complete_node`.** It's the natural place to refuse completion at a checkpoint. Per ADR 0012, guidance for nodes rides tool descriptions.

## Not decided: what the agent actually sees

There are three shapes, and the choice interacts with Jev's latency:
- **Inline.** The verdict is appended to the tool result, so the model reads it in the same step. Costs the Jev round trip on that tool call.
- **Async.** The tool result returns immediately. The verdict arrives as a steering message at the next tool boundary, while the model is writing its next step anyway. It adds no wall time, and the feedback lands one step late.
- **Hybrid.** Wait up to about 300 ms; inline if Jev answers in time, otherwise steer.

Plus `hold` at node completion, for rules about something missing.

## Learnings

### Extraction

- **The judgment can be unstructured; the location can't.** A rule is only extractable if the thing it governs has a structural anchor: a path, a syntax node, a sink a value flows into, or an event in git history. Where there's none (for example, "the refactor wasn't applied to the similar code nobody touched"), it's review's job, not a rule's.
- **Whether a string is a prompt depends on where it goes, not what it says.** Crucible's `src/` has 10,339 string literals. Prompts are found through their homes: prompt files, tool `description` properties with `+` pieces joined, and values flowing into `session.prompt`. Text assembled at runtime needs data-flow tracking.
- **Extractors are static analyzers, not diff filters.** They need the enclosing unit after the edit, resolved identifiers, folded constants, and sometimes history. tree-sitter (`web-tree-sitter` plus `tree-sitter-wasms` grammars) gives language-neutral syntax, not types. **Its trees live in wasm memory and must be freed** (`tree.delete()`): the first survey crashed out of memory without it.
- **A rule's recall is capped by its extractor's net, and nothing reports a miss.** Misses that review catches should widen the net.
- **Good extraction often makes the judge unnecessary.** The middle tier is narrower than it first looks. It fits where the location is structural and exactly one literal semantic question remains.
- **Some rules need the state cleaned.** Jev doesn't treat state as hostile: a comment saying "safe default" can move its answer.
- **Rules about omissions need a checkpoint trigger,** not a per-edit one.
- **A rule that can't be extracted usually points at a missing home in the codebase.** An ADR that gives the thing a home, like prompts in files, turns the rule into a grep.

### Jev, as measured

- **SDK:** `@typesafe-ai/sdk` 0.6.0 and `TYPESAFE_API_KEY`.
  - `client.systemOne({ model, state, questions })`.
  - `noul(instructions, { true, false })` answers `.noul`.
  - `choice(instructions, criteria)` answers `.choice`, `.confidence` and `.probabilities`.
  - `score(instructions, levels)`.
  - Pin `jev-1.13.0`; `jev-latest` moves.
- **Question ids are never sent to the model,** so the instructions must carry the whole meaning. Criteria define what each answer means. State works best as named JSON fields, referred to with backticks. A noul near 0.5 means "equally likely", not "somewhat".
- **Labels:** 3,435 comments from Crucible's 21 comment-police commits. The police removed 886, rewrote 724, and kept 1,868 that its branch had added.
- **Three yes/no questions (describes, explains why, references) barely separated removed from kept:** AUC 0.54 to 0.58, where 0.5 is chance.
- **Comment length alone is the strongest signal.** 43% of rejected comments run over 2 lines, against 6% of kept ones. Structure alone (line count, JSDoc-or-not, trailing-or-not) reaches AUC 0.73. Adding Jev's answers brings it to 0.78. On 1-2 line comments, where length can't help, Jev gives 0.68 against 0.59 for structure.
- **A single `choice` over what the comment is doing (`narrates`, `why`, `contract`, `pointer`, `label`) beat every yes/no wording tried:** AUC 0.676 against 0.55 to 0.65. With it, a `note` matched the police 77% of the time on a balanced sample of 400 short comments. The final rule uses it.
- **Much of the disagreement is label noise, not Jev.** The police is an editor, not a classifier: it deleted genuine why-comments to save space, and kept descriptive field docs. On what a comment is doing, Jev's answer looked right in nearly every disagreement read by hand. Agreement with the police is capped by the police's own consistency. Clean, hand-made labels would be needed to measure Jev itself.
- **Latency:** one call alone took about 450 ms. At 10 concurrent calls the median was 2.6 s (p99 4.7 s), so the early-access service throttles. Sequential single-call latency and how often builder edits add a comment weren't measured.
- **Cost:** about 8,000 calls in total, roughly $0.25. A typical comment item is 300 to 800 input tokens.

### Labels mined from history

- **Heuristics,** in `labels.ts`:
  - "removed": the police commit deleted the comment;
  - "rewritten": the police added a comment within 6 lines of one it deleted;
  - "kept": still there after the police, and git blame puts its introduction in the police commit's first-parent history within 24 hours. The police is told to judge only its own branch's comments.
- **Run records** under the app's `workflow-runs/` carry `baseCommit` and `branch`. Only 13 exist for this workspace path, so they couldn't give branch bases for most police commits.
- **The police's HTML reports,** which explain each change, are run artifacts. They could give much cleaner labels ("removed because it narrates" against "removed for length"), and weren't mined.

### Testing

- **The authoring loop worked as hoped.** A scenario failed (an ADR citation came back `pointer` at 0.64 and escalated), a threshold changed, and the re-run was free and took seconds, with no agent, no run, and no edit to a real file.
- **Scenarios picked where Jev was confident prove the loop, not the accuracy.** Surveys measure accuracy.
- **Rule files in another repo need two things from the runner:** the `crucible:rule` aliases, and to be treated as ES modules whatever that repo's `package.json` says. `register.ts` does both with `module.registerHooks`.

### Rules worth having in Crucible itself

- **Comments,** against the build workflow's `COMMENT_DOCTRINE`. It's the one prototyped.
- **New capability ships with its agent docs.** At a checkpoint, code finds changes to the surfaces agents depend on: `resources/workflow-lib/workflow.ts`, tool definitions and descriptions, `.crucible/` script contracts, commands, skills. Jev then decides whether an agent must know about each change, and a `choice` picks the owning doc. Its options come straight from the "read this when…" lines in `resources/agent-docs/index.md`. If the chosen doc wasn't touched, completion is held.
- **The rules feature documenting itself** (`resources/agent-docs/rules.md`: writing rules, wording Jev questions, testing), which the docs rule would then hold it to.

### Risks noted along the way

- **Goodhart at tool-call speed.** An agent told in real time that a comment narrates may learn to reword it rather than delete it. "Reworded" should be tracked separately from "fixed".
- **Nagging.** A rule the agent can't satisfy needs a bounce cap and an escalation.
- **Never block on a judge that can't be reached.**
- **Code leaves the machine.** Every judged item goes to TypeSafe, so which judges a workspace may use is a workspace setting.
- **Interactive sessions and workflow nodes probably want different defaults.** Nobody watches a node; a user watching a session finds nagging maddening.
- **Rules go stale when their source document gains rulings,** unless updating the rule is part of making the ruling.
