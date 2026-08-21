# 0017 — A run's only voice is a message to its orchestrator

The legacy dashboard let the human answer a run's check-ins and blockers
directly, which meant two conversation surfaces: the session and the run.
We decided a run never converses with the user: check-ins, blockers, errors
and completion are delivered as messages to the orchestrator — the session
agent the run reports to — which answers from its own context or brings the
question to the user in the chat they already have. Run views are read-only
observability plus the mechanical Pause and Cancel; completion works the
same way ("finished in worktree X, pull it in when ready"), so bringing work
back is the agent's judgment, not app machinery or a button. Attention rides
the existing Needs-you system: a run needing the user is expressed as its
orchestrator session needing the user, and an active run is not by itself
attention-worthy.

## Considered Options

An answer box in the run view (the legacy shape) was rejected because it
splits the conversation and bypasses the agent that holds the context.
Automatic merge-on-completion was rejected because it mutates the session's
tree at a moment nobody chose.
