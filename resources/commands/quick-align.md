---
description: Fast functional alignment — settle the end-user experience in a handful of questions, leave the technical shape to the implementation.
argument-hint: "[subject]"
---
# The quick alignment (`/quick-align`)

Reach shared understanding on **what the user will experience** — and nothing
deeper. The implementation owns the technical shape; your job is to hand it a
crisp statement of the intended behavior, fast. Until the interview ends,
this is the only work in this session: no implementation, no commits, no
files written except the ones named below. You are the interviewer. The user
decides.

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

If the subject has a visual surface the workspace hasn't already settled,
settle it the way this project settles visuals — an HTML mock against the
project's design references, iterated until approved — not prose. That mock
is worth more than any number of questions.

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
write the intent brief to `<workspace>/.crucible/align/<YYMMDD>-<slug>.md`
(create the directory; suffix rather than overwrite an existing path), relay
where it is in one sentence, and stop. The brief is the user's. What happens
to it next is their call, not yours.

## The intent brief

The brief is the interview's whole product: the one durable statement of what
was agreed, precise enough to hand to an implementer who heard none of the
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

## Still open

- <Deliberately open questions, or "Nothing.">

## Durable residue from this interview

- `CONTEXT.md`: <terms, or "none">
- `docs/adr/`: <decisions, or "none">

## Source material (read these — do not work from paraphrase)

- <Path or URL, one line each on what to take from it. An approved mock
  belongs here.>
