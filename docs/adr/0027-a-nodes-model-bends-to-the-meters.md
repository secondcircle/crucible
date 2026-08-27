# 0027 — A node's model bends to the meters

A workflow names a model per node, and until now that name was final: a run
started at three in the morning spent whatever the file said, however little
of that model's week was left. Anthropic meters some models on a scoped
weekly window alongside the account's own week, and the two run the same seven
days — so a scoped meter sitting above the account week means that one model
is eating the week faster than everything else together. The engine now asks
before each node starts, and once more when the run is planned so the rail's
forecast is honest: a model whose scoped meter leads the account week is
swapped for its relief (Fable's is Opus), thinking level untouched. The swap
is invisible to the workflow — nothing is passed, nothing declared — because
the workflows must keep saying which model suits the work, not which model is
affordable this Thursday.

An unusable reading never swaps anything. A stale provider, a failed fetch,
an absent meter or a chooser that throws all leave the declared model
standing: pressure has to be seen to be acted on, and a run that quietly
switched models on an hour-old number would be worse than one that spent as
written. The reading comes from the same TTL-gated store the strip draws, so
a run of thirty nodes costs at most one request a minute.

## Considered Options

Making it the workflow author's job — a fallback model beside every node —
was rejected: the pressure is an account fact that changes hourly, and no
file on disk can be right about it. A hard floor ("stop at 95%") was rejected
because the account week is what actually runs out; a scoped meter at 92%
with the week at 67% is a reason to move work, not to refuse it. Swapping in
the SDK adapter, so sessions bent too, was rejected for now: a human picking
a model in the picker is making a choice about this turn and should not have
it silently overruled.
