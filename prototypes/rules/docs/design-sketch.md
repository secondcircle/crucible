# `.crucible/rules`: a design sketch

Yes, one TypeScript file per rule is the right shape, for the same reasons workflows are TypeScript: a rule is code (its extractor is a small static analyzer), it's versioned with the repo it governs, and it can be tested. What makes it work in any repo is a clean split. Crucible owns everything that's the same everywhere: agent events, parsing, git, judges, batching, feedback, the ledger. The repo owns what only it knows: its ADRs, its paths, the names of its own helpers.

Every API below is invented for this sketch.

This sketch was written before and during the prototype in `prototypes/rules/`. Where it and the prototype differ, the prototype and `HANDOFF.md` are the more current.

## The layout

```
.crucible/rules/
  comments.ts                 one rule, default-exports defineRule({...})
  comments.test.ts            its scenarios: what it extracts, and what it decides
  docs-follow-capability.ts   (sketched below, not built)
```

A rule file imports `crucible:rule` the way a workflow imports `crucible:workflow`. The loader aliases it to the copy Crucible ships, so no repo needs a `node_modules` for it.

## The surface a rule writes against

```ts
// crucible:rule

export function defineRule<T extends Trigger, Q extends Questions>(rule: Rule<T, Q>): Rule<T, Q>

export interface Rule<T extends Trigger, Q extends Questions> {
  /** The document this rule enforces. Named in every piece of feedback. */
  source: string
  /** One line, shown in feedback and in the rules view. */
  summary: string
  on: T
  scope?: {
    include?: string[]            // path globs; edit and checkpoint triggers only
    exclude?: string[]
    agents?: 'sessions' | 'nodes' | 'both'   // default 'both'
  }
  /**
   * off: loaded, checked and listed, never fed a live event; only the test runner runs it.
   * shadow: fed live events; every action is recorded as what it would have been, and nothing reaches the agent.
   * enforce: actions reach the agent.
   */
  mode: 'off' | 'shadow' | 'enforce'
  /** Code decides what to judge. An empty list means the rule doesn't apply to this event. */
  extract(event: EventOf<T>, ctx: Ctx): Item[] | Promise<Item[]>
  /** Absent: a deterministic rule, and decide() reads item.meta alone. */
  judge?: Judge<Q>
  decide(item: Item, answers: Answers<Q>): ActionOf<T>
  feedback(item: Item, answers: Answers<Q>): string
  /** When the judge can't be reached. Never 'block'. Default 'log'. */
  unavailable?: 'log' | 'escalate'
}
```

### Triggers and events

```ts
type Trigger = 'edit' | 'bash' | 'commit' | 'checkpoint'

interface EditEvent       { path: string; before: string | null; after: string; changed: LineRange[]; agent: AgentRef }
interface BashEvent       { command: string; cwd: string; agent: AgentRef }
interface CommitEvent     { message: string; files: FileDiff[]; agent: AgentRef }
interface CheckpointEvent { at: 'node-complete' | 'turn-end'; base: string; files: FileDiff[]; agent: AgentRef }
```

`edit` covers π's `edit` and `write` alike: one event per file, the text before and after. `checkpoint` exists for rules about something *missing*, like peers left un-migrated. Those can't be seen per edit, so they see the whole diff since the node or turn began.

### Actions, typed by trigger

```ts
type After      = 'pass' | 'log' | 'note' | 'escalate'
type Before     = After | 'block'
type Checkpoint = After | 'hold'
type ActionOf<T> = T extends 'bash' ? Before : T extends 'checkpoint' ? Checkpoint : After
```

This way a rule can't express a state that has no meaning. `block` exists only where nothing has happened yet, so an edit rule returning `'block'` is a type error, not a runtime surprise. What each action does:

| Action | Where the agent sees it |
|---|---|
| `note` | appended to the tool result it just got, via π's `tool_result` hook |
| `block` | the bash call refused, with the feedback as the reason, via π's `tool_call` hook |
| `hold` | `complete_node` refused until the item is resolved; for a session, a follow-up at turn end |
| `escalate` | nowhere yet; opened in the ledger for a review node to read |
| `log` | nowhere; the rules view only |

### Items and the ledger

```ts
interface Item {
  /** Stable identity across edits: derived from content, never a line number. */
  key: string
  where: { path: string; line: number } | { command: string }
  /** What the judge reads. Keep it small: Jev loses accuracy as irrelevant text grows. */
  state: string
  meta?: Record<string, unknown>
  /** Set when the extractor already knows the answer; the judge is skipped. */
  decided?: string
}
```

The key is what closes the loop. A later edit that produces the same key re-runs the rule. A pass closes the open item, and an item that no longer appears at all counts as resolved. After two notes on one key the ledger stops annotating and escalates, so an agent can't be bounced forever by a rule it can't satisfy.

### Judges

Questions use TypeSafe's own SDK (`@typesafe-ai/sdk`) as-is, so a rule author reads TypeSafe's docs, not ours:

```ts
import { noul, choice, score } from '@typesafe-ai/sdk'

noul(instructions, { true: '…what yes means…', false: '…what no means…' })   // → { noul: number }
choice(instructions, { label: 'description', other: 'description' })            // → { choice, confidence, probabilities }
score(instructions, ['level 0 described', 'level 1 described', …])              // → { score, confidence, probabilities }

type Judge<Q> =
  | { kind: 'classifier'; model: 'jev-1.13.0'; questions: Q }
  | { kind: 'model'; model?: string; questions: Q }
```

Some things from TypeSafe's docs change how a rule is written:
- **Question ids are never sent to the model.** `restates` is a name for code. The instructions have to carry the whole meaning.
- **The judgment goes in `instructions` and what each answer means goes in `criteria`.** A bare question string works, but spelled-out criteria are where boundary cases live.
- **State works best as named JSON fields** (`{ file, comment, preceding_code, following_code }`), referred to from the instructions with backticks: "Does the comment in `comment`…".
- **A noul near 0.5 means "equally likely either way",** not "somewhat". Thresholds belong to the rule and are tuned on the repo's own labels.

The rule examples below use a shorthand (`{ noul: '…' }`). The prototype uses the real calls.

Questions are data rather than a call the rule makes, and that's deliberate. It lets Crucible:
- batch all questions over the same state into one Jev call, across rules;
- cache answers by (model, state, questions);
- run a rule's cases offline to calibrate it;
- swap judges per workspace, sending the same questions to a model on the user's own provider when Jev isn't allowed, or falling to `unavailable`.

### What the context gives an extractor

```ts
interface Ctx {
  read(path: string, at?: 'before' | 'after' | string): Promise<string | null>  // string: any commit-ish
  syntax(path: string, text?: string): Promise<SyntaxTree>   // tree-sitter, language from the extension
  git(args: string[]): Promise<string>
  sh(cmd: string, args: string[]): Promise<{ stdout: string; code: number }>  // the repo's own tools
}
```

Tree-sitter is what makes it language-neutral: one parser, grammars for Go, TypeScript, Python, SQL and so on, and one query language across all of them. It gives syntax, not types. When a rule needs types (which package defines this, what this identifier resolves to across files), `ctx.sh` runs the repo's own tooling, and that time counts against the rule's budget.

On top of `ctx`, Crucible ships the extractors many rules share, in `crucible:rule/extract`:

- `addedComments(edit, ctx, { context })`
- `changedNodes(edit, ctx, query)`: syntax nodes matching a query that overlap the changed lines, whole
- `enclosing(node, types)`
- `declarationsIn(tree, names)`
- `withoutComments(text, lang)`

The `/rule` agent mostly composes these. It writes a new extractor only when no shared one fits.

## What happens on an edit

1. π applies the `Edit`, and the `tool_result` hook fires in the SDK adapter.
2. The adapter sends the event to the **rule host**: one long-lived utility process per workspace, the workflow-host model (ADR 0029) with a longer life, since rules fire all day.
3. The host drops rules by trigger, agent kind and path glob, then runs each remaining extractor under a budget (say 250 ms). A rule that throws or runs over is skipped and put in a warning state, the way a schedule check is. **A broken rule never breaks the agent's turn.**
4. Items from all rules are grouped by (judge, state), one call per group, served from cache when the state hasn't changed.
5. `decide` runs, and actions pass through the ledger (bounce cap, shadow mode).
6. `note` text goes back to the adapter, which appends it to the tool result. The model reads it in the same turn.

The whole path has a ceiling, around a second. Anything over it is delivered late, as a steering message, rather than holding the loop.

## Testing a rule without triggering it

A rule has to be provable before Crucible feeds it a single live event. That means proving it against the real repo and the real judge, without editing a file, spawning an agent, or starting a run. Three pieces make that possible.

### 1. One pipeline, two event sources

The engine's live path and the test runner call the same function:

```ts
evaluate(rule, event, { judge, ledger? }) → { items, answers, actions, feedback }
```

Live, the π hooks are a thin adapter. They turn a `tool_call` or `tool_result` into an `EditEvent` or `BashEvent` and hand it to `evaluate`. Under test, the event is built from the repo instead. Everything after the event (scope, extraction, the judge call, `decide`, and the exact text appended to the tool result) is the same code either way. So a passing scenario means the rule will do that live, not something close to it.

The only part the runner can't cover is the hook adapter itself. It's the same for every rule, and Crucible's own suite tests it once, against the fake adapter.

### 2. `mode: 'off'` for rules still being written

`mode` has three values: `off`, `shadow`, `enforce`. The loader hot-loads every file in `.crucible/rules/` as it changes:

- **An `off` rule** is compiled, checked, and listed in the rules view. It's never subscribed to live events, so an agent writing a comments rule can't be blocked by its own half-finished comments rule. Only the test runner runs it.
- **Moving to `shadow` or `enforce`** makes the loader run the rule's extract-only scenarios first, since those are free and take milliseconds. If any fail, the rule stays off, with a warning naming the failing scenario. Judge scenarios aren't run on load, because they cost money.

So "is it on" is a property of the file, versioned with the rule, and a rule can't switch itself on while its extractor is broken.

### 3. The companion test file

`comments.test.ts` sits beside `comments.ts`. It's built from **scenarios**. A scenario is an event built from the real repo, plus what should come out of it, and what it asserts decides how deep it runs:

- **Items only:** only the extractor runs. It's free, instant, and deterministic. This is where tree-sitter queries, context windows and keys get tested.
- **Actions:** the real judge is called, and `decide` runs on the real answers.
- **Feedback:** the exact text the agent would read is checked, usually as a snapshot.

Event builders read the repo and never write to it:

| Builder | Makes | From |
|---|---|---|
| `edit(path, { replace: [old, new] })` | one `EditEvent` | the file at HEAD, changed in memory |
| `write(path, text)` | one `EditEvent` | the file at HEAD as `before` |
| `commit(sha)` | one `EditEvent` per file | parent version → commit version, i.e. a real past change replayed as if an agent had just made it |
| `checkpoint(base, head)` | one `CheckpointEvent` | any real commit range, standing in for one node's work |
| `bash(command)` | one `BashEvent` | the command, with `cwd` at the repo root |

`commit` and `checkpoint` are what make "test it against the actual repo" real. Every past change in the repo becomes a test input for free, including the exact commit a rule is meant to catch.

#### The comments rule's test file

The real one is `.crucible/rules/comments.test.ts` on this branch: six extraction scenarios (free), four made-up judgment cases, and six real comments from Crucible's history replayed with `existingComment(path, line, at)`.

### The runner

A CLI that ships with Crucible, so an agent can call it from bash, and so can CI:

```
crucible rules test comments                # every scenario; real judge calls, cached
crucible rules test comments --extract-only # items and scope only; free, no network
crucible rules explain comments src/shared/agent/port.ts:98 --at c9a6bfc53^
crucible rules survey comments --commits main~30..main
```

**`test`** runs the scenarios and prints, per failure, the item, the state Jev saw, its answers and the action `decide` chose. For labelled cases it prints a confusion matrix, expected against actual per action, and lists every answer within 0.1 of a threshold. Those are the cases where the bands or the wording should move.

**`explain`** points at one spot in the repo and shows everything the rule does there: whether scope admits the file, the item the extractor builds, the exact state and questions sent to Jev, the raw answers, the action, and the feedback text. It's the debugging view, for when a scenario surprises you.

**`survey`** runs the rule over a corpus with no expectations at all. Every commit in a range gets replayed as edits, or every file gets treated as newly written, so every comment in `src/` is "added". It reports what the rule would have done and what it cost, as a table the panel can show. This is where "how good is Jev at comments" gets answered. Survey the last ten merged branches, look at the table, and turn the rows you disagree with into cases. The Jev doc's first experiment becomes one command.

**Answers are cached** by (model version, question wording, state hash). Changing `decide` thresholds re-runs every scenario for free. Changing a question's wording, or the extractor's context window, re-calls only the items whose question or state changed. That's what makes iterating on the prompt cheap: an agent can reword a question, re-run, and compare the confusion matrix in a minute for a few cents. Before any uncached judge calls, the runner prints what they'll cost and stops at a budget (`--budget 0.25`, default a few cents).

**The same limits as live.** The runner uses the workspace's judge settings and credentials. If this workspace may not send code to Jev, the runner can't either, and judge scenarios report as skipped, not passed.

### What this gives the agent writing a rule

The `/rule` flow becomes a loop an agent can close alone, with no sub-agent and no run:

1. Write the rule with `mode: 'off'` and its test file, extraction scenarios first.
2. `--extract-only` until the items are right: the right comments, the right context, stable keys.
3. `survey` a recent range to see what it would do on real work.
4. Turn disagreements into scenarios or cases, adjust wording and bands, and re-run `test`. It's cached, so this is cheap.
5. Show you the confusion matrix, then switch to `shadow`. The loader re-checks extraction and starts feeding it live events.

### Where it gets proven: Crucible's own repo

The place to answer "how good is Jev at comments" is Crucible itself, and Crucible's history already holds the labels:

- Crucible has a comment doctrine (CONTEXT.md): a comment explains why something non-obvious was done, in a line or two, and references nothing outside the code.
- Its build runs have a comment-police node, and `git log --grep="comment police"` finds **21** of its commits. `944f32c` alone deleted 96 lines across 15 files.
- Every comment a police commit deleted is a `note` case. Every comment that sat in the same diff and survived is a `pass` case.

So the first real rule is Crucible's comments rule, tested with `crucible rules survey comments` over those 21 commits' parent ranges and scored against what the police actually did. That's a confusion matrix against a judge we already trust (a Fable-high node) before anything is wired into a live loop, and it costs a few cents.

## Rules Crucible would run on itself

Crucible's own repo is the first place rules run, so the rules worth writing first are Crucible's.

### Comments, against Crucible's doctrine

The build workflow ships a comment doctrine (`COMMENT_DOCTRINE` in `resources/agent-docs/examples/build.ts`): a comment never describes what the code does, it only explains a decision a reader would find strange, it's a line or two at most, and it references nothing outside the code. Three nouls cover the judgment (`describes`, `explainsWhy`, `references`), and code counts the lines. This is the rule the prototype runs.

### New capability ships with its agent docs

Agents using Crucible learn what it can do from `resources/agent-docs/`, and a capability they can't read about doesn't exist for them. A workflow API field, a new tool, a new `.crucible/` contract: each needs its doc updated in the same change. That's an **omission** rule, so it runs at a checkpoint, and it has anchors:

- **Trigger:** `checkpoint` at node completion, and at the merge gate.
- **What it pulls out (code):** the diff's changes to the surfaces agents depend on. That means exported types and fields in `resources/workflow-lib/workflow.ts`, tool definitions and their descriptions (`src/shared/agent/*-tool.ts`, `*-tools.ts`), the `.crucible/` script contracts, commands and skills. One item per changed exported symbol or tool, with its hunk. If nothing on those surfaces changed, the rule is over.
- **Jev, question 1 (noul), per item:** "Does the change in `code_change` add or alter something an agent writing a workflow or using Crucible's tools must know to use it correctly?" A renamed private helper says no, and a new `NodeSpec` field says yes.
- **Jev, question 2 (choice), per item that says yes:** "Which doc should explain the change in `code_change`?" The options come straight from `resources/agent-docs/index.md`. Each entry there is already a one-line "read this when…", which is exactly what a choice's criteria want, plus "none of these".
- **Code again:** did the diff touch the chosen doc? If yes, pass. There's room for a third question there ("does `doc_change` describe `code_change`?"), but touching the right file is the cheap first cut.
- **Action:** `hold` at node completion. The feedback names the symbol and the doc: "`NodeSpec.skills` changed and `workflow-authoring.md` didn't. Agents writing workflows won't know about it."

### The rules feature documents itself

That second rule applies to the rules feature first. When rules ship, they ship with `resources/agent-docs/rules.md`, listed in the index as "read this when the user asks for a rule, or wants something enforced". It covers:
- the tiers and when a rule belongs in a linter instead;
- the `defineRule` surface, triggers and actions;
- how to write Jev questions: TypeSafe's guidance above, plus the traps found here (state that argues for itself, comments stripped where a rule needs it, recall bounded by the extractor's net);
- the test file and the `crucible rules` runner;
- mode `off` until `test` passes.

The docs rule then holds any change to `crucible:rule` that doesn't update that doc.

## The prototype

`prototypes/rules/` implements this sketch for one trigger (`edit`), outside the app, and `HANDOFF.md` there says what it proved.

## What makes it generic, and where it stops

Crucible provides, for every repo:
- the events, including the two π hooks
- tree-sitter with a grammar pack
- git
- the judges and their credentials
- batching and caching
- the ledger and delivery
- the case runner
- the rules view
- the shared extractors

The repo provides the rules, the cases, and repo facts: the names of its helpers, where config lives, what its ADRs actually say. Workspace settings decide which judges this workspace may send code to.

Where it stops:
- **Syntax, not types.** Tree-sitter can't resolve an identifier across files. A rule that needs that shells out to the repo's own tools and pays for it in its budget.
- **Overlap with linters.** A deterministic rule that a repo's linter could express belongs in the linter. This framework's deterministic tier is for what linters can't see: agent events, bash commands, history across a node's work.
- **A repo's own view of enforcement.** Some repos rule that judgment belongs to review alone. Rules add a third tier, a verdict handed to the agent as evidence, and a repo that adopts them should say so in its own decision records.
- **Rules rot with their sources.** Every new ruling on an ADR can change what its rule should do. Recording a ruling should include updating the rule and its test cases, or the rule enforces last month's ADR.
