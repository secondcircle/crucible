# 0006 — The agent learns Crucible from docs shipped with the app

Users extend Crucible by asking an agent in a session ("make me a command that…"), and the installed app may run on a machine with no Crucible source checkout, so the agent can never rely on reading this repository. We decided Crucible ships its agent-facing documentation — how commands work, where they live, their format, and whatever the agent must later know to extend the app — inside the app itself, exposed to every session, and any change to agent-visible behavior updates those shipped docs in the same change. This mirrors how π documents itself to its own agent.

## Consequences

Behavior is described twice (code and shipped docs), and the docs can drift; keeping them current is part of the definition of done for any feature agents can act on, not a separate chore.
