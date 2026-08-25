# 0020 — ADRs record only current decisions; git holds the rest

Standard ADR practice never deletes: a decision that is replaced gets marked
superseded and stays in the folder, so the record of what was once believed
survives. That serves a large team doing archaeology years later, and it
serves this repository badly. Every agent Crucible starts is told its
decisions live in `docs/adr/`, so the whole folder is context on every node of
every run, and a folder where a third of the files are dead costs that on
every turn. Worse, 0013 and 0016 already showed the failure mode: one ADR
amending another's central sentence means neither can be read alone, and an
agent that reads only the first comes away with a rule that is no longer
true. We decided the folder holds what is currently decided and nothing else.
An ADR that no longer describes a live decision is deleted, and `git log
--follow` is the history — which an agent will actually run, where a human
would not.

Deletion is safe only under one precondition, and it is the whole of the
safety: an ADR may be removed only once the ADR that replaces it names the
abandoned shape and why it failed, in its Considered Options. The reason a
path was rejected is what stops it being proposed again, and that reason has
to survive somewhere a reader will land. Numbers are never reused or
renumbered — gaps are free, and a reused number makes archaeology resolve to
the wrong decision.

The second half of the decision follows from the first: nothing outside
`docs/adr/` cites an ADR by number. Not comments, not prompts, not lint
messages. A number is an unstable identifier that means nothing at the point
of use, and citing one couples every deletion to a sweep of the codebase.
Where code or a prompt needs to point at the record, it points at the folder
and says what to look for. Cross-references between documents survive, ADR to
ADR included: those are read by someone who can see both files, and they are
what carries the replaced-shape reasoning that makes deletion safe.

## Consequences

The convention we broke is one every agent has been trained on, so left alone
an agent will eventually "repair" the folder by adding tombstones back. This
repository's `adr-audit` workflow (`.crucible/workflows/adr-audit.ts`) is
what holds the line, and this ADR is what tells the audit's own agents why
the line is there.

## Considered Options

Keeping superseded ADRs as stubs pointing at their successors was rejected:
it keeps the context cost and the two-files-to-read-one-rule problem while
adding a folder that only grows. Dropping numbers from filenames entirely, so
citation by number became impossible, was rejected because "ADR 0009" is a
useful handle in conversation and the ban on citations achieves the same end
without renaming anything.
