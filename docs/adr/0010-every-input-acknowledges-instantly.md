# 0010 — Every input acknowledges instantly

Dogfooding found a summarizing jump that gave no sign for several seconds and
then snapped the view elsewhere; the user assumed it was broken. We decided
acknowledgment is a blanket obligation, not a per-feature choice: every user
input produces visible feedback in the same frame the input lands, no matter
how long the real work takes. What the feedback is depends on the context — a
disabled control, a spinner, a pulsing element, a busy note — but silence is
never acceptable, and work that takes real time (an LLM call, a bind, a
search) must show a waiting state for its whole duration, not just complete
eventually. A control that cannot act yet says so rather than ignoring the
click. Reviewers and builders treat a missing acknowledgment as a defect on
par with wrong data.

## Considered Options

Leaving feedback to each feature's design was rejected: three separate builds
shipped silent waits (summarize, and earlier the scroll pin and thinking
stream), so the pattern recurs unless it is a standing rule checked in
review.
