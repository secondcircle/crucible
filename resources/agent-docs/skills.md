# Crucible skills

You are running inside a session of Crucible, a desktop app built on π. This
page tells you how Crucible's skills work, so that when the user asks for one
("make a skill for how we write migrations"), you can write it and it works
immediately.

## What a skill is

A skill is a folder holding a `SKILL.md`: instructions you read for yourself
when your task matches what the skill says it is for. Every skill available to
a session is announced in the system prompt by name and description, and the
file itself is read only when you decide it is relevant. Nobody invokes a
skill. There is no `/skill:name` grammar in Crucible's composer, and there
never will be — a user who wants a skill applied says so in words, or writes a
command.

That is the difference from a command: a command is a message the user sends,
a skill is a document you go and read.

The other difference is portability. A skill is written in the Agent Skills
format, which is not Crucible's — the same folder works unchanged in π or in
any other runner of that format. So a skill carries practice that holds in any
repository. Anything true only inside Crucible belongs in one of these docs
instead, behind the index that names them.

## Where skills live

Three origins, exactly as commands resolve:

- **workspace** — `.crucible/skills/` inside the workspace folder you are
  working in. Use this for practice specific to this codebase.
- **user** — `~/.crucible/skills/`. Use this for practice the user wants in
  every workspace on this machine.
- **built-in** — shipped inside Crucible itself and read-only. You cannot
  write these; they change when the app updates.

A name defined in more than one place resolves workspace first, then user,
then built-in, so a workspace skill shadows a user skill of the same name, and
either shadows a built-in. Write to the workspace folder when the practice is
about this project, to the user folder when it is not, and ask if it is
genuinely unclear.

A folder that does not exist yet is simply empty of skills — create it when
you write the first one. Crucible reads the folders fresh on every turn, so a
skill you write is available in the very next message the user sends. No
restart, no reload, no registration, and nothing anywhere to enable.

Crucible does not read π's own skill folders (`.pi/skills`,
`~/.pi/agent/skills`). Files there are invisible here; a skill must be in one
of the three folders above.

## File format

One directory per skill, containing `SKILL.md`: YAML frontmatter, then the
body.

```markdown
---
name: writing-migrations
description: How this project writes and reviews database migrations. Read
  before adding, editing or reviewing a migration file.
---

# Writing migrations

...
```

- `name` — lowercase letters, digits and hyphens, at most 64 characters, no
  leading, trailing or doubled hyphen. Convention is that it matches the
  directory name.
- `description` — required, at most 1024 characters. This is the only part of
  the skill that is always in front of you, so it is what decides whether the
  skill is ever read. Write it in the third person and make it say both what
  the skill covers and when to reach for it. A description that only names a
  topic gets the skill ignored.
- The body is instructions to the reader, in markdown. Keep it short. Anything
  long moves into a supporting file in the same directory, referenced by a
  relative path, so the body stays scannable and the detail is read only when
  it is wanted.

Relative paths inside a skill resolve against that skill's own directory, not
against the working directory.

## What a skill costs

Every skill spends a description line in the prompt of every agent, in every
session and every workflow run, whether or not it is ever read. That is the
reason a skill has to earn its place: it is standing guidance in front of
every agent, not a document filed somewhere.

Two consequences worth holding to. Do not write a skill for something one
prompt could say. And do not turn Crucible-specific knowledge into a skill:
those are docs behind the index, which costs one prompt line no matter how
many of them there are.

## Skills in a workflow run

The agents inside a workflow run get skills too. A node's project-local origin
is the run's own worktree, so a skill the run's branch adds is visible to the
nodes that follow it.

By default a node is offered every skill the worktree resolves. A node spec
may narrow that:

```ts
await ctx.node('review', {
  prompt: '...',
  skills: ['writing-agent-prompts']
})
```

Absent means every skill; a named list means those and no others; an empty
list means none at all. A name matching no skill is ignored.

## When a skill read shows up

A read of any file at or under a skill's own directory is displayed in the
tool chain as `skill` rather than `read`, summarized by the skill's name. The
collapsed chain head counts skills, so `1 skill · 3 read` says at a glance
that a skill fired. That is also how the user finds out whether the skills
here are earning their place, so do not be shy about reading one when it
matches.

## A worked example

The user asks: "write down how we do migrations, so you stop getting it wrong".
Write `.crucible/skills/writing-migrations/SKILL.md` in the workspace:

```markdown
---
name: writing-migrations
description: How this project writes, names and reviews database migrations,
  including the expand-then-contract rule for column changes. Read before
  adding, editing or reviewing any migration file.
---

# Writing migrations

Every migration is reversible or explicitly marked irreversible, with the
reason in a comment at the top.

A column change is two deployments, never one: add the new column and write to
both, then remove the old one once nothing reads it. A migration that renames
a column in place will be rejected in review.

Name the file for what it does to the schema, not for the feature that wanted
it: `add-orders-cancelled-at`, not `cancellation-feature`.

See `review-checklist.md` in this directory before reviewing someone else's.
```

Then tell the user it is in place and applies from their next message. It is,
and it does.
