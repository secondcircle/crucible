# 0005 — A workspace service owns OS facts, not the agent port

File search and bash runs are facts about the workspace folder, not about any
agent, but they could have been bolted onto the agent port since main already
owns workspaces there. We decided they live behind a separate Crucible-owned
workspace service (its own IPC, its own fake for tests), and only the moment
something enters the conversation — adding a bash run's output — crosses the
agent port. This keeps the port's meaning intact as the SDK-replacement seam:
file search and bash runs survive any SDK swap untouched, at the cost of a
second service beside the port.

## Considered Options

Extending the agent port with `searchFiles` and `runCommand` was rejected
because it would dilute the port into a general main-process RPC surface and
drag OS concerns through the one seam that must stay agent-only.
