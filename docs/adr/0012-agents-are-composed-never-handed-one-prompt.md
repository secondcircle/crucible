# 0012 — Session agents are composed, never handed a single prompt string; node agents take the workflow's text verbatim

π's stock prompt opens by telling the agent it is "operating inside pi, a
coding agent harness" and then spends seven lines pointing it at π's own
documentation under /opt/homebrew, none of which is true of a Crucible session
and all of which the layer below should keep to itself. We decided every
session agent Crucible starts is composed of two layers: a role prompt, which
is its replaceable identity, and the standing prompt, appended whatever the
role says. A pure module composes them and the SDK adapter passes the result
as a full override, so π's stock prompt is never used, never edited and never
filtered. The standing prompt admits only text true of every session agent,
independent of its job: the communication style qualifies, tool guidance and
docs pointers do not. Both layers ship as files under `resources/`, not as
string constants.

A workflow node is the other kind of agent Crucible starts, and it is barely
composed. Its system prompt is a short shipped opening, the node base, with
the workflow file's `system` field sent verbatim after it, or the opening
alone when the field is absent; its first user message is the file's
`prompt` field, verbatim. The engine writes no role, appends no standing
prompt, and adds no list of inputs, outputs or schema. The reason is who owns
the text: a session's prompt is Crucible's product, while a node's prompt is
the workflow author's, and every word the engine adds is a word the author
cannot see in the file or remove, sent on every turn of every node. The
opening is the one exception, and it exists for the provider rather than the
model: π's stock prompt is never sent for any Crucible agent, because a
request that opens with it is billed by Anthropic as something other than
Crucible's own traffic, and a workflow file written before `system` existed
must still run.

## Consequences

A full override takes the whole prompt, so nothing riding π's generated
sections survives it: the guidelines a custom tool used to contribute, and any
doc appended to the prompt, are simply gone. Guidance an agent must always have
therefore travels in a tool's `description`, which rides the request's tools
parameter, or in a shipped doc the role prompt points at and the agent reads
when asked. For nodes this is the only channel Crucible has: how a node
finishes, that ending a message is not completion, that a blocker parks it and
the answer arrives as the next message, all live in the descriptions of
`complete_node` and `raise_blocker`, and the verdict schema rides
`complete_node`'s parameter schema. A blank session layer would let the SDK
fall back to π's own prompt, so the composition module throws on one rather
than returning an empty string, and a launch that cannot read a prompt file it
ships fails loudly, naming the file, and the node base is read at wiring for
the same reason. A node with no `system` runs under the base alone, which
knows nothing of runs or finishing, and a workflow that wants more says so
in the file. What π's resource loader appends for every agent, the
worktree's `AGENTS.md` files and the skills block, reaches nodes and sessions
alike; that text is the repository's and π's, not Crucible's.

## Considered Options

Composing nodes the way sessions are composed, a shipped node role plus the
standing prompt plus an engine-written appendix listing the node's inputs,
outputs and verdict schema, was how nodes ran first and was rejected. A
pipeline of 106 nodes cost $1,768 and its author could not tell from the
workflow file what any node had been told, because part of every node's
context was text the file did not contain. The appendix also let workflow
prompts lean on it ("the reports listed among your inputs"), so the prompts
read as incomplete on their own. Making the appendix optional was rejected for
the same reason: a node's prompt is either what the file says or it is not.
Sending nothing at all when `system` is absent, so π's stock prompt stood in,
was how verbatim prompts shipped first and was rejected the same day: every
node of a workflow without `system` was refused by the provider as out of
extra usage, while sessions on the same subscription ran.
