---
description: Fast functional alignment — settle the end-user experience in a handful of questions, leave the technical shape to the implementation.
argument-hint: "[subject]"
---
# The quick alignment (`/quick-align`)

Reach shared understanding on **what the user will experience** — and nothing
deeper. The implementation owns the technical shape; your job is to hand it a
crisp statement of the intended behavior, fast. Until the interview ends,
this is the only work in this session: no implementation, no commits, no
files written except prototypes and the ones named below. You are the
interviewer. The user decides.

The subject: ${@:-(none given - make asking for it your first question)}

Before asking anything, read what this workspace has already settled:
`CONTEXT.md`, `docs/adr/`, the design references, and whatever code the
subject touches. Most technical questions you might be tempted to ask are
already answered there — that is the point of having settled them.

## What you may ask about

Only end-user experience and functional behavior, and only where a **genuine
trade-off** exists: two or more answers a reasonable person could pick, with
visibly different consequences for the person using the app.

Everything else, you decide:

- **Technical and architectural choices** are not questions here. Leave them
  to the implementation; do not pin them in the brief.
- **One-right-answer questions** — where every alternative to your
  recommendation is obviously wrong — are decisions, not questions. Make
  them, and let them surface in the brief marked as yours so the user can
  veto at a glance.
- **Facts** are found, never asked. Go and find them with your own tools.

Expect one round, occasionally two. Format each question like so, numbered
continuously so the user can point back at one:

```
❓ **Q1** - **<question title>**: <question body>

➡️ <your recommended answer>
```

Zero questions is a legitimate interview: if the subject has no real
functional trade-offs, restate what you understood, confirm it, and end.

## Push for prototypes

Anything non-obvious in the subject is a prototyping candidate: a visual
surface the workspace hasn't already settled (an HTML mock against the
project's design references, iterated until approved), a library this project
has never used (a small spike proving it does the job), a risky integration.
Name each candidate and push the user to decide whether to prototype it —
the pushing is the job, because hands-off builds only work from align issues
with prototypes. An approved mock is worth more than any number of questions.

An accepted prototype is built during the interview, before the issue
exists: the issue ships complete, never with prototypes trailing in later. A
declined one is recorded in the brief's Prototyping section, so a build knows
where it flies blind. Prototype files never land in the repository's working
tree or history — they exist to be shipped with the issue.

## Glossary and ADRs

Update `CONTEXT.md` inline when a term crystallizes: the entry is the term in
bold, one or two sentences on what it IS, and an `_Avoid_:` line naming the
rejected synonyms. This interview is the only writer of `CONTEXT.md` and the
only author of `docs/adr/`. Offer an ADR only when a decision is hard to
reverse, surprising without context, and a real trade-off — a combination this
interview should rarely produce.

## Ending it

When nothing functional is left open, ask, in these words:

> Do you agree we are fully aligned?

Anything short of a clear yes is another question. On the yes, and only then,
create the align issue as described below, relay its URL in one sentence, and
stop. The issue is the user's. What happens to it next is their call, not
yours.

## The align issue

The interview's product is an issue on the workspace's issue host, labeled
`align` — the marker a future build chain looks for — whose body is the
intent brief below and which ships with every prototype. Never write the
brief into the repository.

Which host is the workspace's existing configuration, never a question:

- `.crucible/jira.json` present → **Jira**. Credentials are the `JIRA_*`
  keys in `.env.local` at the workspace root. Create the issue in the
  configured project — type Task, unassigned, label `align`, the intent
  brief as its description — then attach every prototype file to it through
  the attachments API.
- Otherwise → **GitHub** through `gh`. Ensure the label exists first
  (`gh label create align`; already-exists is fine), then `gh issue create`
  with the brief as body and the `align` label, unassigned. GitHub issues
  take no file attachments: put all prototype files in one secret gist
  (`gh gist create`) and link it from the brief's source material.

If creation fails — missing auth, network — preserve the brief in a file
outside the repository (a temp path), say exactly what failed and where the
brief is, and stop. The brief is never silently dropped.

## The intent brief

The brief is the align issue's body: the one durable statement of what was
agreed, precise enough to hand to an implementer who heard none of the
conversation. Write rulings in the user's sense, never blurred with your
recommendation. The template, in full:

# Alignment — <the subject, in one line>

**Intent brief · output of `/quick-align` · <YYYY-MM-DD>**

## What we're building

<One to three paragraphs. A reader who was not in the interview must finish
this knowing what the user will experience and why it is worth building.
Behavior, not mechanism.>

## Rulings — what the user settled

- **Q1 <title>:** <the decision as the user made it, with their reason where
  they gave one.>

## Decided without asking — veto anything here

- <Each decision you made under the one-right-answer rule, one line each,
  with the alternative you rejected. If you made none, say "Nothing.">

## Constraints and non-negotiables

- <Only what the design may not violate. Technical shape is the
  implementation's — do not smuggle it in here.>

## Prototyping

- <Each prototype built: one line on what it proves and where it is attached
  or linked. Each declined candidate, marked declined. Or "Nothing was worth
  prototyping.">

## Still open

- <Deliberately open questions, or "Nothing.">

## Durable residue from this interview

- `CONTEXT.md`: <terms, or "none">
- `docs/adr/`: <decisions, or "none">

## Source material (read these — do not work from paraphrase)

- <Path or URL, one line each on what to take from it. Every prototype
  belongs here — as an attachment on Jira, in the linked gist on GitHub.>
