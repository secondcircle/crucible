# 0007 — Commands are Crucible-owned; the agent port never sees them

π has its own prompt-template system (`.pi/prompts`, `~/.pi/agent/prompts`, expansion inside `session.prompt()`), and adopting it verbatim was considered. We decided Crucible owns the whole command mechanism instead: files in `~/.crucible/commands/` and `<workspace>/.crucible/commands/` plus built-ins shipped with the app, discovered and `$`-argument-expanded by a Crucible-owned command service in the main process, so the agent port only ever carries the expanded plain text. The format deliberately copies π's semantics (filename as name, frontmatter `description`/`argument-hint`, `$1`/`$@`/`${1:-default}`) so files move between the two systems, but the spec is Crucible's.

## Considered Options

Using π's template system directly was rejected because it puts a π storage concept in the user's face, couples the command story to the SDK the port exists to make replaceable (ADR 0001, ADR 0004), and buys little — expansion is trivial string substitution. The cost accepted: Crucible ignores `.pi/prompts` entirely and forgoes future π template features.
