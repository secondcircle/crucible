---
name: writing-agent-prompts
description: Guidance for writing or changing any text an agent will read as instructions, whether a task prompt, a role or system prompt, an AGENTS.md, a reusable command body, or another skill file. It covers what a prompt carries (the goal, the reason, the constraints, the context it cannot find for itself, and how far the work goes), what it must not carry (a rubric, a step list, an example of the expected answer), and how specific to be about method. Read it before writing such text, and before reviewing someone else's.
---

# Writing prompts an agent will act on

A prompt is a brief for a capable colleague who has never seen this problem
and cannot ask you a question. Everything below follows from that.

## What a prompt carries

**The goal.** What the finished work is, stated as an outcome someone could
check. "Make the retry policy consistent across the two clients" is a goal.
"Look at the retry code" is a wish.

**The reason.** Why this work is wanted. The reason is what an agent falls
back on when your instructions run out, which they always do. Without it,
every unanticipated fork gets resolved by guesswork.

**The constraints.** What must hold no matter how the work is done: an
interface that cannot change, a file that must not be touched, a dependency
that must not be added, a behavior that must survive. Say the ones that bind.
Ceremonial constraints ("write clean code") cost attention and change nothing.

**The context it cannot find for itself.** The decision made last month, the
reason the obvious approach was already rejected, the name of the one file
that explains the rest. An agent can read the repository. It cannot read
anything that was only ever said out loud.

**How far the work goes.** How much is authorized and when to stop. This is
the part most prompts omit; see `scope-boundaries.md`.

## What a prompt does not carry

Not the method, when the method is genuinely open. Do not write out the steps
you imagine taking, and do not attach a rubric the work will be scored
against.

The reason is worth stating plainly, because it is what makes the rule hold
under pressure: a goal survives a model upgrade untouched, while a rubric
encodes the weaknesses of whatever model you wrote it against. Every "check
your work twice", "do not hallucinate file paths", "remember to actually run
the tests" is a patch for a specific failure someone once saw. Those patches
accumulate, they are never removed, and each one spends attention that the
actual problem needed.

The same rule catches a common instinct: do not ask an agent to verify what it
already verifies. If the work is done by running a command that fails loudly,
saying "make sure it passes" adds nothing but length. Ask for verification
only where the check is real and would not otherwise happen: a case the suite
does not cover, a manual step, a claim nothing enforces.

## Examples: the shape, never the answer

An example of the *expected answer* is the one thing an example must never be.
It gets copied. You will get your own example back, lightly reworded, with the
real problem unexamined, and you will not be able to tell whether the thinking
happened.

An example of the *shape* is different, and it is the best tool there is for
steering format and tone. Show a worked instance of something adjacent: a
finished piece of the same kind, about a different subject. The structure, the
register and the level of detail all transfer; the content cannot.

So: to fix format, show a filled-in example from elsewhere. To fix tone, show
a paragraph that sounds right, about something else. To fix scope, show the
size of a finished unit, not its content. Never show the answer to the
question you are asking.

## Specificity matches fragility

Specificity is not a virtue to be maximized. Match it to how narrow the
correct path is.

Where exactly one route works, give it exactly: the command with its flags,
the file with its path, the name spelled as it must be spelled. Guessing here
is not creative, it is just wrong, and an agent that has to guess will burn
turns discovering what you already knew.

Where many routes work, say what the destination is and let the route be
chosen. Pinning a method that did not need pinning throws away the judgment
you asked for, and it ages badly: the pinned method is a snapshot of what was
best when you wrote it.

The test is one question: if this were done differently, would that be wrong,
or just different? Wrong means be exact. Different means say less.

## Vagueness is not open-endedness

Leaving a prompt vague on purpose, hoping for range, does not produce range.
It produces the smallest defensible interpretation, delivered quietly, with no
sign that anything was left out. Nobody comes back to ask which reading you
meant. You get the cheapest one, and it looks finished.

If you genuinely want several approaches, ask for several approaches and say
how they should differ. If you do not know what you want, say that, and say
what would make the answer clear. A prompt admitting an open question gets a
better answer than a prompt hiding one.

## Address the reader

Write to the agent, in the second person, as instructions rather than as
description. "Read the two adapters and make their retry behavior identical"
beats "This task is about retry consistency."

State facts as facts and preferences as preferences. An agent cannot tell your
firm requirement from your idle aside unless the words do it: "must",
"never", and "prefer, but not at the cost of X" all mean different things and
all get honored.

## Read it back before you send it

Read the prompt as though you knew nothing else about the project, and answer
these:

- Is the goal checkable, or only recognizable?
- Does it say why, so an unforeseen fork can be resolved without me?
- Does it say when to stop?
- Is every constraint load-bearing, or is some of it ceremony?
- Is anything in here a patch for a mistake someone once saw?
- Is anything specific that did not need to be?
- Would a competent stranger read this the way I intend, or the cheapest way?

Whatever survives those questions is the prompt.
