# The comments rule, running on Crucible

One real rule, `.crucible/rules/comments.ts`, with its test file beside it. The prototype runner makes real Jev calls against Crucible's own history. The rule is `mode: 'off'`, so nothing live runs it.

## How it works, in plain terms

**When it fires.** After any agent's `edit` or `write` to a TypeScript or JavaScript file under `src/`, `scripts/` or `resources/workflow-lib/`. Everything else drops out on its path.

**What it pulls out.**
- Crucible has the file's text before the tool ran and after.
- tree-sitter lists the comment blocks in both, grouping consecutive `//` lines into one block. Lint directives (`eslint-disable`, `@ts-expect-error`) aren't comments for this purpose.
- Any block whose text is in the new version and not the old is **added**. An edit that adds no comment ends here: no call, no delay.
- Each added comment becomes one item:
  - the state is the comment, the 4 lines before it and the 12 lines after it, as named JSON fields;
  - code counts the comment's lines, because Jev can't count.

**What Jev is sent.** One real item, a comment the comment police removed in `c9a6bfc`:

```json
{
  "model": "jev-1.13.0",
  "state": {
    "file": "src/shared/agent/port.ts",
    "comment": "/** Everything the shell knows about itself, in one value. */",
    "preceding_code": "  /** Absent until the adapter has reported real usage (TB-2). */\n  readonly usage?: …\n}\n",
    "following_code": "export interface ShellSnapshot {\n  readonly workspaces: readonly WorkspaceState[]\n  …"
  },
  "questions": {
    "purpose": {
      "type": "choice",
      "instructions": "What is the comment in `comment` mainly doing?",
      "criteria": {
        "narrates": "Restates or summarizes what the adjacent code does, or names what a value is, which the code already shows.",
        "why": "Explains the reason for a non-obvious choice: a constraint, a failure the obvious approach would hit, or an intent the code cannot show.",
        "contract": "States a guarantee or rule that callers rely on and the signature does not show.",
        "pointer": "Points to something outside the code: a document, an ADR, an issue or question id, a design mock, or how the code came to be.",
        "label": "Names a section or a group of lines."
      }
    }
  }
}
```

**What comes back.** `narrates`, confidence 0.96. The probabilities for all five options come too. 771 input tokens, about $0.00003.

**What the rule does with it.**

| Condition | Action |
|---|---|
| more than 2 lines | `note`, whatever Jev says (the doctrine's "a line or two at most") |
| `why` or `contract` | `pass` |
| `pointer`, confidence ≥ 0.5 | `note` (a pointer often names a reason's topic too, which splits the vote) |
| `narrates` or `label`, confidence ≥ 0.7 | `note` |
| anything else | `escalate` to review |

A `note` is appended to the agent's `Edit` result: "src/shared/agent/port.ts:98 describes what the code does. Delete it, or say why the code does something a reader would find strange."

## The test file

`.crucible/rules/comments.test.ts` has 16 scenarios, and all of them pass:

- **Six extraction scenarios.** No Jev: a new comment is found with its context, an edit adding none yields nothing, consecutive `//` lines are one item, lint directives are skipped, markdown is out of scope, and a police commit that only deletes comments adds none.
- **Four made-up judgment cases.** Narration is noted, a hidden reason passes, three lines are noted on length, an ADR citation is noted.
- **Six real comments from history.** Each is replayed from the commit before a police pass as if an agent had just written it. Three the police removed are noted; three it kept pass.

The history cases use a new builder, `existingComment(path, line, at)`: a comment that exists at any commit, replayed as newly added. It's the cheapest way to pin a real case in a test.

These six were picked where Jev was confident, so they show the loop works end to end, not how accurate it is. The survey below measures accuracy.

A full test run costs $0.0003 the first time and nothing after, because answers are cached. The ADR scenario first failed (`pointer`, confidence 0.64, escalated). I lowered the pointer threshold and re-ran in seconds for free. That's the loop you described: the agent fixes the rule without an agent run and without editing a real file.

## What the history says

The labels come from Crucible's 21 comment-police commits: 3,435 comments, of which the police removed 886, rewrote 724, and kept 1,868 that its branch had added.

**First version: three yes/no questions (describes, explains why, references).** A full survey, $0.108.
- On their own, the three questions barely separate removed from kept: AUC 0.54 to 0.58, where 0.5 is a coin flip.
- Length alone does much better. 43% of rejected comments run over 2 lines, against 6% of kept ones. Line count, JSDoc-or-not and trailing-or-not together reach AUC 0.73.
- Jev adds to that. With its answers on top, the combination reaches 0.78. On 1-2 line comments, where length can't help, Jev gets 0.68 against 0.59 from structure.

**Rewording experiment.** 400 short comments, balanced, 800 calls, $0.02. I tried four wordings on the same items:

| Signal | AUC |
|---|---|
| `purpose` choice: narrates, label or pointer | **0.676** |
| `purpose` choice: narrates only | 0.650 |
| original "explains why" (inverted) | 0.648 |
| "would a reader lose information if deleted?" | 0.603 |
| original "describes" | 0.594 |
| "could a reader guess all of it?" | 0.575 (0.556 with 4 lines of context) |

One `choice` over what the comment is doing beats separate yes/no questions, and it's one question instead of three. With it, a `note` agrees with the police 77% of the time on that sample, and wrongly notes 15 of 200 kept comments.

**Why the ceiling is lower than it looks.** I read the disagreements, and most of them are the police, not Jev. The police is an editor, not a classifier. It deletes real why-comments to save space. It removed "`reset_at` is unix seconds → epoch ms. A value already large enough to be milliseconds is left alone rather than multiplied into the year 58000", which Jev calls `why` at 0.96, and I agree. In the other direction it keeps descriptive field docs like "ISO of the tip commit." Agreement with the police is capped by how consistent the police is. On what each comment is actually doing, Jev looked right to me in almost every disagreement I read.

**Speed.** One call alone took 450 ms. Under 10 concurrent calls the median was 2.6 s (p99 4.7 s), so the early-access service is throttling. Per edit that's still one call per new comment, but it's worth knowing before the live loop waits on it.

## The final-question survey

See `HANDOFF.md` for the whole-corpus numbers with the `purpose` question, and `results/` for the raw data.

## Where things are

- `.crucible/rules/comments.ts` and `comments.test.ts`, at the repo root.
- `prototypes/rules/`: the runner. It resolves `crucible:rule`, `crucible:rule/extract` and `crucible:rule/test` for rule files in any repo, the way the workflow loader aliases `crucible:workflow`.
- `results/`: the first survey (three yes/no questions), the rewording experiment, and the final survey.
