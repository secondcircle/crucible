# 0008 — Context panel state rides the agent port, not a service

The context panel reads exhibit files off disk, which looks like an OS fact
that ADR 0005 would send to a service beside the port. We decided panel state
is agent behavior instead: the tabs exist only because an agent called
`panel_show`, so the three panel tools are exposed by each adapter (π
`customTools` in the SDK adapter, canned scripts in the fake), both delegate
to one Crucible-owned panel model in the main process, and panel state
crosses the agent port as events — the file on disk is merely the exhibit's
body. One shared model keeps fake and SDK semantics from drifting; putting
the state anywhere but the port would split a single agent-driven feature
across two seams.

## Considered Options

A second workspace-service-style channel was rejected because, unlike file
search or bash runs, nothing about the panel exists independently of an
agent's tool calls.
