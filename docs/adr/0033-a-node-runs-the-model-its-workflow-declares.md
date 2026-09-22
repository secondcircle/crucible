# 0033 — A node runs the model its workflow declares

A workflow names a model per node, and that name is final. The engine asks
nothing about usage before a node starts, and the run view's forecast of a
planned node shows the model the plan named, so what the file says, what the
rail projects and what the node spends are one and the same string. A node
whose model is unknown to the catalog fails loudly; nothing stands in for it.
The quota strip keeps reading the meters, but reading is all it does.

## Considered Options

The engine used to bend a node's model to the meters: when a model's scoped
weekly meter led the account's own week, the node ran its relief instead
(Fable's was Opus), once at plan time and again at start, with the swap
hidden from the workflow. That shape is abandoned because the hidden choice
was worse than the overrun it avoided. The rail's forecast disagreed with the
workflow file whenever the meters were high, so the author could not tell
which model a node would run until it ran, and the two swap points could
disagree with each other when pressure moved between planning and starting.
A choice about money that no file records and no surface names is not one a
run should make on its own. If a model is too expensive this week, the author
changes the file. A fallback model beside every node, and a hard usage floor,
were rejected for the reasons the abandoned ADR gave and stay rejected: the
first puts an hourly account fact in a file, the second refuses work rather
than moving it, and neither is wanted now that nothing moves work at all.
