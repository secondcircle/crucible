---
description: Grill an idea into shared understanding — glossary entries and ADRs as they crystallize, an intent brief on the confirming yes.
argument-hint: "[subject]"
---
# The alignment interview (`/align`)

Interview the user relentlessly until you reach a shared understanding. Until
the interview ends, this is the only work in this session: no implementation,
no refactors, no commits, and no files written except mocks and the ones
named below. You are the interviewer. The user decides.

The subject: ${@:-(none given - make asking for it your first question)}

Before the first round, read what this workspace has already settled:
`docs/adr/` and whatever code the subject touches. Arriving at round 1 in the
workspace's own words costs a minute and saves a round.

## The rounds

Map this as a **design tree**: every decision branches into the decisions that
hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose
prerequisites are already settled: the questions you can ask _now_ without
guessing at answers you haven't heard yet. Ask the whole frontier in one
round: number each question and give your recommended answer. Then wait for
the user's answers before the next round.

Each question should be formatted like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Each round the user answers reshapes the tree: settled decisions push the
frontier outward and unblock questions that depended on them. Recompute the
frontier and ask the next round. A question whose answer depends on another
question still open in this round belongs to a _later_ round, not this one.
Number questions continuously across rounds (Q1…Q7, then Q8…) so the user can
point back at one.

Finding _facts_ is your job, never the user's. When a frontier question needs
a fact from the environment — the filesystem, the git history, a config file —
go and find it with your own tools; don't ask the user for anything you could
look up yourself. Don't block the round on it either: only the questions
downstream of that fact wait, so ask the rest of the frontier now and come
back to those. The _decisions_ are the user's: put each to them and wait.
Recommend always; decide never. Argue once where you disagree, then record
what they chose, in their sense of it.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the existing language in
`CONTEXT.md`, call it out immediately. "Your glossary defines 'cancellation'
as X, but you seem to mean Y — which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical
term. "You're saying 'account' — do you mean the Customer or the User? Those
are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific
scenarios. Invent scenarios that probe edge cases and force the user to be
precise about the boundaries between concepts.

### Settle visuals with mocks, not prose

If the subject has a visual surface the workspace hasn't already settled,
settle it the way this project settles visuals — an HTML mock against the
project's design references, iterated until approved — not prose. Questions
about layout, hierarchy, or look are answered faster by a mock the user can
react to than by any number of rounds: show the mock, take the reaction,
revise, as part of the round it belongs to. The approved mock is settled
scope and goes in the brief's source material.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If
you find a contradiction, surface it: "Your code cancels entire Orders, but
you just said partial cancellation is possible — which is right?"

### Update CONTEXT.md inline

When a term is resolved, update `CONTEXT.md` right there. Don't batch these up
— capture them as they happen. `/align` is the ONLY writer of `CONTEXT.md` and
the ONLY author of `docs/adr/`, in any workspace: a term that needs adding or
sharpening is raised here, never patched in passing.

`CONTEXT.md` lives at the workspace root; create it lazily when the first term
is resolved. It is a glossary and nothing else — totally devoid of
implementation details, never a spec, a scratch pad, or a repository for
implementation decisions. Each entry is the term in bold, a one or two
sentence description of what it IS (not what it does), and an `_Avoid_:` line
naming the synonyms this project rejects. Be opinionated: when multiple words
exist for the same concept, pick the best one and list the others under
`_Avoid_`. Only include terms specific to this project's context — general
programming concepts don't belong even if the project uses them extensively.
Group terms under subheadings when natural clusters emerge.

If a `CONTEXT-MAP.md` exists at the root, the workspace has multiple contexts:
read it to find where each `CONTEXT.md` lives and infer which one the current
topic relates to. If unclear, ask.

### Offer ADRs sparingly

Only offer to create an ADR when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they
   do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and
   you picked one for specific reasons

If any of the three is missing, skip the ADR — an easy reversal will just be
reversed, and nobody wonders why about the obvious.

ADRs live in `docs/adr/` and use sequential numbering: `0001-slug.md`,
`0002-slug.md`, etc. Scan for the highest existing number and increment by
one; create the directory lazily when the first ADR is needed. An ADR is a
short title and 1-3 sentences: what's the context, what did we decide, and
why. Add **Considered Options** or **Consequences** only when they add genuine
value. Write it the moment the decision settles, never batched at the end.

## Ending it

The interview is done when the frontier is empty: every branch of the design
tree visited, nothing left silently assumed. Then ask, in these words:

> Do you agree we are fully aligned?

Anything short of a clear yes is another round — a "yes, but…", a fresh
question, a hesitation. Do not write the intent brief before the yes:
authorization is the user's utterance, and you never write it, infer it, or
advance past it.

On the yes, and only then:

1. Write the intent brief to `<workspace>/.crucible/align/<YYMMDD>-<slug>.md`
   (create the directory), in the shape below. If that path already exists,
   add a numeric suffix instead of overwriting it: an earlier brief is
   somebody's input and must never change under them.
2. Relay where the brief is, in one sentence, and stop. The interview is over.

The brief is the user's. What happens to it next is their call, not yours.

## The intent brief

The brief is the interview's whole product: the one durable statement of what
was agreed, precise enough to hand to an implementer who heard none of the
conversation. Write the rulings in the user's sense rather than your
recommendation's, and never blur what they said with what you synthesized. The
template, in full:

# Alignment — <the subject, in one line>

**Intent brief · output of `/align` · <YYYY-MM-DD>**

## What we're building

<Two or three paragraphs, or a numbered list of the pieces, each one or two
sentences. A reader who was not in the interview must finish this section
knowing what is being built and why it is worth building. Settled scope only:
nothing here was invented after the yes.>

## Rulings — what the user settled

- **Q1 <title>:** <the decision as the user made it, in one or two
  sentences, with their reason where they gave one.>
- **Q2 <title>:** <…>

<Every answered question appears here, in order. This section is the
interview's residue: anything you synthesized rather than heard says so in its
own words.>

## Constraints and non-negotiables

- <What the design may not violate: behaviour to preserve, budgets, deadlines,
  principles carried forward, things explicitly ruled out and why.>

## Still open

- <Each question deliberately left open, with one line on why it was left.
  "Nothing" is a legitimate entry — say it rather than omitting the section.>

## Durable residue from this interview

- `CONTEXT.md`: <terms added or sharpened, by name>
- `docs/adr/NNNN-slug.md`: <decisions recorded, by title>

## Source material (read these — do not work from paraphrase)

- <Path, URL, or prior work, each with one line saying what it is for and what
  to take from it. An approved mock belongs here.>
