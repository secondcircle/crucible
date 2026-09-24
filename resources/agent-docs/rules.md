# Rules

A **rule** is one TypeScript file in a repository's `.crucible/rules/` that
watches what agents do in that workspace, in curated sessions and in workflow
run nodes, and hands them feedback while they work. It reads an event (an
edit, a bash call, a commit, a checkpoint), pulls out the narrow thing it
governs, optionally asks a **judge** one literal question about it, and
decides an action. Every decision is a **firing**, recorded in the workspace's
ledger. The person reads every firing on the **rules board** (the `§ N rules`
chip in the top bar), and sees a **rule mark** on each tool call a rule
judged.

Read this before writing or changing a rule, and when the user asks for
something to be enforced.

## Is it a rule at all?

A rule fits into one of three tiers. Put each check in the cheapest tier that
can express it.

- **A linter.** A repository's linter or type checker can already express
  anything decided from one file's syntax: a banned import, a naming
  pattern, an unused variable. Put it there. It runs in the editor and in CI
  without Crucible, and it fails a build rather than annotating a turn.
- **A deterministic rule** (no `judge`). This is for what a linter cannot
  see: agent events, bash commands before they run, history across a node's
  work, and things that are missing at a checkpoint. `extract` and `decide`
  are code, and a firing costs nothing.
- **A judged rule** (`judge` set). This fits only where the location is
  structural and exactly one literal semantic question remains: "is this
  comment narrating the code?", "does this string go to a model?". The
  code finds the spot, and the judge answers the question about it.

Good extraction often makes the judge unnecessary. If you cannot say where
the thing a rule governs lives (a path, a syntax node, a place a value
flows into, a commit), then it is review's job, not a rule's. A rule that
cannot be extracted usually points at a missing home in the codebase: an
ADR that gives the thing a home turns the rule into a grep.

## The files

```
.crucible/rules/
  comments.ts        default-exports defineRule({...})
  comments.test.ts   its scenarios
```

The file name is the rule's name. Rule files import three modules, which
Crucible aliases to the copies it ships, so no repository needs a
`node_modules` for them:

- `crucible:rule`: `defineRule`, plus TypeSafe's own question builders
  `noul`, `choice` and `score`, re-exported from `@typesafe-ai/sdk`.
- `crucible:rule/extract`: shared extractors. Use `addedComments(edit, {
  following, preceding })` for the comments an edit added or reworded, and
  `commentBlocks(path, text)` for every comment in a file, found with
  tree-sitter.
- `crucible:rule/test`: `scenario` and the event builders a test file uses.

Rule code never runs in Crucible's main process. It runs in the workspace's
rule host (one long-lived process per workspace) and in the `crucible rules`
runner. Both run the same `evaluate`, so a scenario that passes in the runner
means the rule does the same thing live.

## `defineRule`

```ts
import { choice, defineRule } from 'crucible:rule'
import { addedComments } from 'crucible:rule/extract'

export default defineRule({
  source: 'docs/adr/0042-….md',        // the document it enforces; named in every note
  summary: 'One line for the board',
  on: 'edit',                          // 'edit' | 'bash' | 'commit' | 'checkpoint'
  scope: { include: ['src/**/*.ts'], exclude: ['**/*.d.ts'], agents: 'both' },
  mode: 'off',                         // 'off' | 'shadow' | 'enforce'
  budgetMs: 250,                       // extract's budget per event; the default
  extract: (edit) => addedComments(edit),
  judge: { model: 'jev-1.13.0', questions: { purpose: choice('…', { … }) } },
  decide: (item, answers) => 'note',
  feedback: (item, answers) => `${item.path}:${item.line} …`,
  unavailable: 'log',                  // when the judge can't be reached: 'log' | 'escalate'
})
```

- **Triggers.**
  - `edit` sees one file changed by one `edit` or `write` call, as
    `{ path, before, after }`, with `before` null for a new file.
  - `bash` sees a command before it runs.
  - `commit` sees a commit an agent's bash call made.
  - `checkpoint` sees everything since the node or the turn began
    (`at: 'node-complete' | 'turn-end'`). It is for rules about something
    missing, which no single edit can show.
- **`scope`.** Path globs apply to `edit`, `commit` and `checkpoint`.
  `agents` picks curated sessions, run nodes, or both.
- **Items.** `extract` returns a list of items. An empty list means the rule
  does not apply to this event, and nothing is judged or paid for. The board
  counts such events as "nothing to judge" and never shows them as rows.
  Each item carries:
  - `key`: derived from content, never from a line number. It is how a later
    edit is recognised as the same item, fixed or reworded.
  - `path` and `line`.
  - `state`: what the judge reads.
  - `excerpt`: the item in its surroundings, shown on the board.
  - `decided` (optional): an action the extractor already knows, which skips
    the judge.
- **Actions** are typed by trigger, so an action that has no meaning is a
  type error:

  | Action | Allowed on | What the agent sees |
  |---|---|---|
  | `pass` | every trigger | nothing |
  | `log` | every trigger | nothing; the board only |
  | `note` | every trigger | the feedback, appended to the tool result it just got if the rule answered within about 300 ms, otherwise steered in as a message at the next tool boundary |
  | `escalate` | every trigger | nothing; the firing stays open on the board for a person or a review node |
  | `block` | `bash` only | the call is refused, with the feedback as the reason |
  | `hold` | `checkpoint` only | a node's `complete_node` is refused with the feedback; a session gets it as a follow-up at the end of the turn |

  No action edits a file.

  Every note names the rule and its `source`, as
  `§ Rule "<name>" (<source>): <feedback>`. After two notes on the same key,
  the next one escalates instead, so a rule an agent cannot satisfy does not
  bounce it forever.
- **Failure never breaks a turn.** A rule that throws, or whose `extract`
  runs past `budgetMs`, is skipped for that event and shown as broken on the
  board. That lights the chip.

  A judge that cannot be reached never blocks: the rule falls back to
  `unavailable`, which defaults to `log`. An unreachable judge also lights
  the chip.

## Writing judge questions

Judged rules use Jev (`jev-1.13.0`; pin the version, because `jev-latest`
moves) through TypeSafe's SDK, as-is. Read TypeSafe's docs for the builders.
What changes how a rule is written:

- **Question ids are never sent to the model.** `narrates` is a name for your
  code. The instructions have to carry the whole meaning.
- **The judgment goes in `instructions`, and what each answer means goes in
  the criteria.** Boundary cases live in spelled-out criteria.
- **State works best as named JSON fields**, such as
  `{ file, comment, preceding_code, following_code }`. Refer to them from the
  instructions in backticks: "What is the comment in `comment` mainly
  doing?". Keep state small, because Jev loses accuracy as irrelevant text
  grows.
- **A `noul` near 0.5 means "equally likely either way",** not "somewhat".
  Thresholds belong to `decide`, and are tuned on the repository's own
  cases. A `choice` answers with every option's probability, and the board
  shows them all.
- **Count in code.** Jev cannot count lines or characters. Anything
  structural (length, position, whether it is JSDoc) goes in `meta` and is
  decided in code.

The traps found writing the first rule:

- **State that argues for itself.** Jev does not treat state as hostile. A
  comment that says "safe default" or "this is intentional" moves its answer.
  When the thing judged can speak, frame the question so its own claim
  doesn't count as evidence, or clean the state first.
- **Strip comments where the rule needs it.** When the question is about
  code, comments in the surrounding code are text that argues. Strip them
  from `state` unless the rule is about them.
- **Recall is bounded by the extractor's net, and nothing reports a miss.**
  The judge only ever sees what `extract` returned. When review catches
  something the rule should have seen, widen the net and add that case as a
  scenario.

## The test file and the runner

`<name>.test.ts` sits beside the rule and registers scenarios. A scenario is
an event built from the real repository, without writing to it, plus what
should come out:

```ts
import { commit, edit, existingComment, scenario, write } from 'crucible:rule/test'

scenario('a narrating comment is found', edit('src/x.ts', { replace: ['a()', '// call a\na()'] }), { items: 1 })
scenario('markdown is out of scope', write('docs/x.md', '# x'), { outOfScope: true })
scenario('a police commit adds none', commit('944f32c'), { items: 0 })
scenario('a real narrating comment is noted', existingComment('src/x.ts', 12, 'abc123'), {
  actions: [{ is: 'note' }],
})
```

The builders are `edit(path, { replace: [old, new] }, at?)`, `write(path,
text, at?)`, `commit(sha)`, `range(base, head)`, `bash(command)`,
`checkpoint(base, head)`, `commitEvent(sha)` and `existingComment(path, line,
at)`. The last one replays a comment from history as if it had just been
added.

What a scenario asserts decides how deep it runs. `items` and `outOfScope`
run only the extractor: they are free, instant and deterministic. `actions`,
`feedback` and `feedbackIncludes` call the real judge.

The runner is on every agent's PATH:

```
crucible rules test <rule> [--extract-only] [--budget 0.50] [-v]
crucible rules explain <rule> <path:line> [--at <rev>] [--extract-only]
crucible rules explain <rule> --command '<bash command>' [--extract-only]
crucible rules survey <rule> [--extract-only] [--limit N] [--budget 0.50]
```

- **`test`** runs every scenario. For each failure it prints the item, the
  state the judge saw, its answers and the action chosen.
- **`explain`** shows everything the rule does at one spot: whether scope
  admits it, the item, the exact state and questions, the raw answers, the
  action, and the exact feedback text. The board's "Explain in terminal"
  button runs it for the firing you are reading.
- **`survey`** runs the rule over the repository with no expectations and
  writes a report of what it would have done and what that cost. Turn the
  rows you disagree with into scenarios.

Answers are cached by model, questions and state, so changing `decide`
re-runs for free, and rewording a question re-asks only what changed.
Before any uncached call, the runner prints the cost and stops at
`--budget`.

The runner follows the same settings as live. If this workspace is not
allowed to send code to a judge, judge scenarios report as skipped, not
passed.

## Modes, and switching a rule on

`mode` belongs to the file and is hot-loaded. Nothing in the app toggles it.

- **`off`**: loaded, checked and listed on the board (dimmed), never fed a
  live event. Only the runner runs it. Every new rule starts here, so a
  half-written rule cannot interrupt the agent that is writing it.
- **`shadow`**: fed live events, and every firing is recorded as what it
  *would* have done ("would note"). Nothing reaches the agent, and outcomes
  are still followed, so the board shows whether the agent fixed it anyway.
- **`enforce`**: actions reach the agent.

Keep a rule `off` until `crucible rules test <rule>` passes. When the file
moves to `shadow` or `enforce`, the loader runs its free scenarios first. If
any fails, the rule stays off and the board shows it under "Needs attention",
naming the failing scenario. Move to `enforce` only after the board shows its
shadow firings are the ones you want, and only when the user says so.

## Settings and the ledger

Both settings are Crucible's, and neither is ever read from the repository:

- **The judge credential** is `TYPESAFE_API_KEY=...` in
  `~/.crucible/typesafe.env`.
- **The judges a workspace allows** are listed in `~/.crucible/judges.json`,
  as `{ "<workspace path>": ["jev-1.13.0"] }`. A judged rule whose judge is
  not allowed stays off. That is the user's choice, not a fault, and it
  does not light the chip.

Every firing, admitted event, outcome (`fixed`, `reworded`, `ignored`, or
still open) and reaction (the agent's next words and next edit of that file)
is appended to the workspace's ledger, one JSON object per line. The ledger
is never pruned, and the board reads everything it shows from it. To tune a
rule, read the same file: it is under Crucible's state directory as
`rules/ledgers/<folder>-<hash>.jsonl`. A worktree's rules and ledger are its
main checkout's.
