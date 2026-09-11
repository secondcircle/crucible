# Web research in Crucible

Crucible reaches the public web through one tool: the `firecrawl` CLI. This
page says how that tool gets to an agent, so that "can our workflow nodes use
firecrawl?" is answerable without an experiment.

## Two pieces, both on this machine

The **CLI** is an ordinary program on PATH, installed once by hand with
`npm i -g firecrawl-cli`. Crucible never installs, upgrades or bundles it.

The **connection** is the CLI's own stored credential. The user signs in
once, in Crucible under Settings → Research, and the CLI keeps the key
itself. Crucible passes no key around: every research call it makes strips
`FIRECRAWL_*` from the environment so the CLI can only use what it stored.

Both are per machine, not per workspace, per session or per run. Once the
CLI is installed and connected, any process that runs `firecrawl` on this
machine is signed in.

## Who gets it

Every agent with `bash` — a session, a workflow node, a scheduled run's
nodes. There is no switch to flip and nothing to declare in a workflow: a
node's bash runs on this machine with the app's PATH, so `firecrawl` is
there for exactly the same reason `git` is.

The guidance that goes with it is the built-in `firecrawl` skill. Sessions
and workflow nodes are both offered every built-in skill by default, so a
node whose task needs the web sees the same description line a session does
and reads the skill when it matters. The one way to lose it is a node spec
that names a `skills` list and leaves `'firecrawl'` out; see `skills.md`.

## When it is not there

The skill tells the agent what to do, and the rule is the same in a run as
in a session: report which of the two pieces is missing and stop. Not
installed means `npm i -g firecrawl-cli`, by the user. Installed but not
connected means Settings → Research, by the user. A node in that position
raises a blocker naming the missing piece; the fix is one command or one
click and never belongs to an agent.

## Two things a workflow author should settle

`.firecrawl/` has to be git-ignored in the repository a run works in. A run
commits its whole worktree when it ends, so an un-ignored scrape lands on
the branch. Ignore the folder once in the repository rather than leaving
every node to do it.

Firecrawl fetches from the cloud. It cannot see `localhost`, a dev server in
the worktree, or a private network. A node that needs one of those uses
`curl`.
