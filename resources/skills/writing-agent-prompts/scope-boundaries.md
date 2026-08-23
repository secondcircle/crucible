# Scope boundaries

A prompt that says what to do and not how far to go is only half written. The
missing half is the one that produces both of the expensive failures: work
that stops short of what was wanted, and work that keeps going long past it.

An agent has no way to infer the size of a job. The same sentence, "fix the
flaky test", covers a one-line timeout bump and a rewrite of the fixture
layer. You know which one you meant. Nothing in the words does.

## Say how much is authorized

Name the edge of the work in whatever terms actually bound it:

- **By artifact.** "Change only the two client files and their tests."
- **By blast radius.** "No schema change, no new dependency, no public API
  change."
- **By effort.** "If this turns out to need more than a small refactor, stop
  and say so."
- **By depth.** "Fix this instance. Do not go looking for others."

One of these is usually enough. The point is that the sentence exists at all.

## Say what to do at the edge

An agent that hits your boundary and finds no instruction will do one of two
things, both bad: cross it silently, or stop silently. Say which you want.

- Stop and report, with what was found and what it would take.
- Do the part that fits and list the rest.
- Ask, if there is somebody to ask and the wait is cheaper than the wrong
  answer.

"If you find the same bug in other adapters, list them and leave them alone"
is a complete instruction. "Fix the bug" is not.

## Say what done means

Done is a state, not a feeling. Give the agent something it can check itself
against:

- The tests that must pass, named.
- The files that must exist, or the change that must be visible.
- The question that must be answerable, and where the answer goes.

If done cannot be checked, the work cannot be finished, only abandoned. That
is worth noticing before you send the prompt rather than after.

## Under-scoping and over-scoping look different

Under-scoped work comes back small and quiet. There is no error, nothing looks
wrong, and the gap only shows up when somebody uses it. That is why the
smallest defensible reading is the expensive one: it is invisible.

Over-scoped work comes back large and plausible: a fix, plus three
refactorings you did not ask for, plus a rename that touches forty files. It
is harder to review than the problem was to solve, and reverting it costs more
than the fix was worth.

Both are the same missing sentence.

## Bounding open-ended work

Some work has no natural edge: an audit, a survey, a cleanup. For that kind,
bound it by budget rather than by artifact.

- "Read the ten most recently changed files, not the whole directory."
- "Three findings, worst first, then stop."
- "One pass. Do not iterate on your own findings."

A budget is not a limit on quality. It is what makes the result comparable to
something and finishable at all.
