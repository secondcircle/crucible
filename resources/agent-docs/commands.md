# Crucible commands

You are running inside a session of Crucible, a desktop app built on π. This
page tells you how Crucible's commands work, so that when the user asks for
one ("make me a command that reviews a PR"), you can write it and it works
immediately.

## What a command is

A command is one markdown file. The user invokes it in the composer as
`/name args`; Crucible expands the file into plain prompt text before anything
reaches you. You never see the invocation, only the expanded text.

The filename minus `.md` is the command name: `align.md` is `/align`.

## Where commands live

Three origins:

- **workspace** — `.crucible/commands/*.md` inside the workspace folder you
  are working in. Use this for commands about this codebase.
- **user** — `~/.crucible/commands/*.md`. Use this for commands the user wants
  in every workspace.
- **built-in** — shipped inside Crucible itself and read-only. You cannot
  write these; they change when the app updates.

A name defined in more than one place resolves workspace first, then user,
then built-in, so a workspace command shadows a user command of the same name,
and either shadows a built-in. Write to the workspace folder when the command
is about this project, to the user folder when it is not, and ask if it is
genuinely unclear.

Discovery is not recursive: only `*.md` files sitting directly in one of those
folders count, never files in subfolders. A folder that does not exist yet is
simply empty of commands — create it when you write the first file. Crucible
reads the folders fresh on every use, so a command you write is available in
the very next thing the user types. No restart, no reload.

Crucible does not read π's own prompt-template folders (`.pi/prompts`,
`~/.pi/agent/prompts`). Files there are invisible to Crucible; a command must
be in one of the three folders above.

## File format

Optional YAML frontmatter, then the body:

```markdown
---
description: Review a pull request with structured issue and code analysis
argument-hint: "<PR-URL> [focus]"
---
Review the pull request at $1.

Focus on ${2:-bugs, security issues and error handling}. Report what you find
as a numbered list, worst first.
```

- `description` shows in the command popover. When it is missing, the first
  non-empty line of the body stands in, so write a first line that reads well.
- `argument-hint` shows beside the name in the popover. The convention is
  `<angle brackets>` for a required argument and `[square brackets]` for an
  optional one. It is free text and is never parsed.
- Everything after the frontmatter is the body. Only the body is substituted
  into, and the delivered text is the body with leading and trailing blank
  space trimmed.

Write the body as an instruction to yourself, in the second person, the way
you would want to be told. It becomes the user's whole message.

## Arguments

The user's argument string is split on whitespace, except that a double-quoted
span is one argument with the quotes stripped:

```
/component Button "click handler"    →   $1 = Button, $2 = click handler
```

The forms you may use in the body:

| Form                     | Expands to                                                  |
| ------------------------ | ----------------------------------------------------------- |
| `$1`, `$2`, …            | The argument at that position; empty when it was not given   |
| `$@` or `$ARGUMENTS`     | Every argument, joined with single spaces                    |
| `${1:-default}`          | Argument 1 when it is there and non-empty, otherwise `default` |
| `${@:-default}`          | Every argument when there are any, otherwise `default`       |
| `${ARGUMENTS:-default}`  | The same thing                                               |
| `${@:2}`                 | The arguments from position 2 on                             |
| `${@:2:3}`               | Three arguments starting at position 2                       |

Anything else that merely looks like one of these stays exactly as written;
there is no escape character.

## A worked example

The user asks: "give me a standup command that takes an optional number of
days". Write `.crucible/commands/standup.md` in the workspace:

```markdown
---
description: Summarize recent work, today's plan and blockers from git
argument-hint: "[days]"
---
Read the last ${1:-1} day(s) of git history in this workspace, including
branches I have not merged.

Write a standup: what got done, what is in flight, and anything that looks
blocked. Keep it to five lines.
```

Then tell the user it is ready and that `/standup 3` covers three days. It is,
and it does.
