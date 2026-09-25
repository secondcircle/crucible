# What the file tree shows

You are running inside a session of Crucible. The file tree in the sidebar, and
the `@file` search in the composer, list the same files: git's listing of the
workspace (`git ls-files --cached --others --exclude-standard`), or, outside a
repository, a walk of the folder that honors every `.gitignore` in it. `.git`
is never listed.

That leaves some things out that the user may still want to open. The usual
one is a folder of repositories of their own inside this one. The outer
repository ignores them, or git lists an untracked one as a single opaque
entry, so none of their files appear. It can also be a single file the
`.gitignore` names.

`.crucible/files.json` at the workspace root changes that listing:

```json
{
  "show": ["repos"],
  "hide": ["node_modules", "dist"]
}
```

Both keys are optional. The file takes effect as soon as it is saved: the tree
redraws on its own and the next `@file` search reads it. No restart. Commit it
if the whole team works this way, since a session's worktree reads the copy in
that worktree.

## `show`

Each entry is a path or a glob, from the workspace root. What it matches is
listed even when git ignores it.

- `repos` or `repos/`: everything in that folder.
- `repos/*/src/**`: a glob. `*` and `?` stay inside one folder, and `**`
  crosses folders.
- `.env.example`: one file, by name.

A shown folder is walked past the workspace's own ignore rules, but a
repository inside it keeps its own `.gitignore`. So `"show": ["repos"]` lists
every nested repository the way that repository's own `git status` would see
it, with its `dist/` or `target/` still left out if it ignores them.

## `hide`

Each entry is a path or a glob. What it matches is never listed and never
walked into, git's own listing included. A name without a `/` matches at any
depth, so `node_modules` hides every `node_modules` folder.

When the file has no `hide` key, `hide` is `["node_modules"]`. Writing a
`hide` key replaces that default. Keep `node_modules` in the list unless the
user really wants to see it.

## Setting it up for the user

1. Find what is missing. Ask git why a path is left out with
   `git check-ignore -v <path>`. A nested repository shows up in
   `git status --porcelain` as a single `?? name/` line, or not at all if the
   outer `.gitignore` names it.
2. Write `.crucible/files.json` with the narrowest `show` that covers it.
   Prefer the folder over `**` from the root: a shown folder is walked file by
   file, and a walk stops after 20,000 files.
3. Add a `hide` for anything big in there that nothing ignores, keeping
   `node_modules`.
4. Tell the user what you wrote and which folders now appear. The tree has
   already redrawn by the time you say so.

Nothing here changes what git tracks, what `git status` reports, or what the
agent can read. It is only what the tree and `@file` list.
