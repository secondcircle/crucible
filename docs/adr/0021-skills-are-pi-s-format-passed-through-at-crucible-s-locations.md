# 0021 — Skills are π's format, passed through, at Crucible's own locations

Crucible owns its commands outright (ADR 0007) and hands every agent a full
system-prompt override so π's stock prompt never reaches a session (ADR 0012),
so the expected call for skills was to own that mechanism too. We decided the
opposite: skills stay π's format and π's loader, discovered at Crucible's own
three origins — `<workspace>/.crucible/skills/`, `~/.crucible/skills/`, and
built-ins shipped in `resources/skills/` — with workspace shadowing user
shadowing built-in, exactly as commands resolve. π's own skill folders
(`.pi/skills`, `~/.pi/agent/skills`) stay ignored, consistent with the ruling on
π's prompt folders. The SDK is configured with `noSkills` plus explicit paths,
which turns off π's locations while keeping its loader, its `SKILL.md`
frontmatter contract, and the `<available_skills>` block it appends after the
override.

What makes the inconsistency with commands deliberate is what each mechanism is
for. A command is Crucible's own composer UX, invoked by the user, and owning it
kept a π storage concept out of the user's face. A skill is portable practice an
agent reads for itself, and a skill file moving between π, Crucible and any
other runner of the Agent Skills format untouched is the whole value. The same
line decides where new agent-facing material goes: anything Crucible-specific
ships as an agent doc behind the docs index (ADR 0006), anything that holds in
any repository ships as a skill. Neither folder is allowed to become the other's
junk drawer.

## Consequences

π composes the `<available_skills>` preamble, so its wording now reaches every
Crucible agent — the single exception to a full override otherwise admitting
only Crucible's own text, accepted because the text is short, accurate, and free
to maintain. Because skills are the one thing that survives that override, a
skill is also the only way to put standing guidance in front of an agent without
touching the role or standing prompt, which makes the boundary rule load-bearing
rather than tidy. Run nodes receive every skill by default and a workflow may
narrow a node to a named subset, so a node's context stays the workflow author's
to control. A read of any file inside a skill's directory is attributed to that
skill and rendered in the tool chain as `skill` rather than `read`, so whether a
shipped skill is earning its place is visible in the transcript and greppable in
Crucible's own logs.

Discovery re-reads the folders when Crucible starts a turn, which fixes the skill
set for the whole of that turn. A steering message or a follow-up into a turn
already running keeps the set that turn began with, so a skill written mid-turn
reaches the next thing the user sends rather than the work in flight. Two smaller
consequences follow from the same place. An unreadable folder cannot be allowed
to fail a send, because discovery sits on the path that echoes the user's own
message back into the transcript, and π's loader reports an unreadable folder as
an empty one anyway, so the two cases are indistinguishable from here. And a
session whose skill set has not changed returns `undefined` rather than an equal
array, because handing back a fresh array re-bills the prompt cache for a prefix
that did not move.

## Considered Options

Owning the whole mechanism the way commands are owned — Crucible's own file
format, its own loader, its own prompt block — was rejected. It buys consistency
with commands at the cost of the portability that is the entire point of a
skill, and it would mean rebuilding a block π already composes correctly for
free. Reading π's skill folders as well as Crucible's was rejected for the same
reason the prompt folders are ignored: it invents a shared-directory contract
with another program and lets a dev launch reach state the installed app also
reads. Converting the shipped agent docs into skills was rejected because they
describe things that exist only inside Crucible, and the docs index costs one
prompt line regardless of how many docs sit behind it, where each skill costs a
description line in every prompt.
