# 0012 — Agents are composed, never handed a single prompt string

π's stock prompt opens by telling the agent it is "operating inside pi, a
coding agent harness" and then spends seven lines pointing it at π's own
documentation under /opt/homebrew, none of which is true of a Crucible session
and all of which the layer below should keep to itself. We decided every agent
Crucible starts is composed of two layers: a role prompt, which is its
replaceable identity, and the standing prompt, appended whatever the role says.
A pure module composes them and the SDK adapter passes the result as a full
override, so π's stock prompt is never used, never edited and never filtered.
The standing prompt admits only text true of every agent Crucible will ever
start, independent of its job: the communication style qualifies, tool guidance
and docs pointers do not. Both layers ship as files under `resources/`, not as
string constants, and the layering is why a future node agent picks a role
cheaply, though no node machinery is built for it now.

## Consequences

A full override takes the whole prompt, so nothing riding π's generated
sections survives it: the guidelines a custom tool used to contribute, and any
doc appended to the prompt, are simply gone. Guidance an agent must always have
therefore travels in a tool's `description`, which rides the request's tools
parameter, or in a shipped doc the role prompt points at and the agent reads
when asked. A blank layer would let the SDK fall back to π's own prompt, so the
composition module throws on one rather than returning an empty string, and a
launch that cannot read a prompt file it ships fails loudly, naming the file.
