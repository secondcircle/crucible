# Connecting a repository to Jira

You are running inside a session of Crucible. The issue board (⌘I) reads the
issues you could pick up in this workspace. It knows two hosts: GitHub, which
it finds by itself from the `origin` remote, and Jira, which it finds only from
two files you write.

This page is everything you need to connect a repository to Jira end to end. If
the user asked you to do that, or the board told them Jira is not set up here,
do the steps below in order and the very next ⌘I shows the project's issues. No
restart.

## What the board does with Jira, and what it never does

It reads. It asks Jira who the credentials belong to, then asks for the
configured project's open issues, and draws them. That is all.

Nothing on that board writes to Jira. No transition, no assignment, no label,
no comment, ever, whatever the user clicks. The client behind it has no code
path that could grow one. When you tell the user what you set up, you can say
that plainly.

What the board does write is a session of the user's own: pressing Enter on a
ticket starts one, in a worktree, with the ticket's key in its first message.

## Step 1: check that `.env.local` is ignored, before anything else

The credentials live in `.env.local` at the workspace root. That file holds an
API token, so it must never be committed.

Check first:

```bash
git check-ignore -q .env.local && echo ignored || echo NOT IGNORED
```

If it is not ignored, add it and commit that change before you write a single
credential:

```bash
echo '.env.local' >> .gitignore
```

Do it in this order. A token written into a tracked file is a token you have to
rotate, not a mistake you can undo with an edit.

## Step 2: write the credentials into `.env.local`

Three keys, spelled exactly like this, one `KEY=VALUE` line each:

```
JIRA_BASE_URL=https://your-team.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=ATATT...
```

- `JIRA_BASE_URL` is the site, with no trailing path. A trailing slash is fine.
  Keep the `https://`: a bare hostname cannot address a request, and the board
  lists `JIRA_BASE_URL` as missing until it has a scheme.
- `JIRA_EMAIL` is the Atlassian account the token belongs to.
- `JIRA_API_TOKEN` is an API token, not a password. Two ways to get one:
  - copy the values from a sibling repository that already talks to the same
    Jira: look for `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN` in that
    repository's own `.env.local`. This is usually what the user means when
    they say the values exist already;
  - or mint a fresh one at `https://id.atlassian.com/manage-profile/security/api-tokens`.
    Minting needs a browser, so ask the user to do it and paste the token
    rather than trying to do it yourself.

Reading of this file is deliberately plain: `KEY=VALUE`, one per line, blank
lines and `#` comments ignored, and the value is everything after the first
`=` with the surrounding whitespace trimmed. Do not quote the values. Do not
write `export`.

Crucible reads these keys from this file and from nowhere else. Setting them as
shell environment variables does nothing, and that is on purpose: an app
launched from the Dock inherits no shell.

## Step 3: name the project in `.crucible/jira.json`

```json
{ "projectKey": "EK" }
```

Exact path, inside the workspace folder: `.crucible/jira.json`. The project key
is the prefix of the ticket keys, so `EK-341` means `EK`.

This file is meant to be committed. It holds no secret, and committing it means
the next person to clone the repository has the board working already. Unknown
fields in it are ignored, so nothing breaks if a later version of Crucible
learns to read more from it.

The project key comes from this file only. A `JIRA_PROJECT_KEY` line in
`.env.local` is not read, however many other tools in the repository use one.

## What tells Crucible this is a Jira repository

The presence of `.crucible/jira.json`. It wins over an inferred host, so a
repository with a GitHub remote and this file reads its issues from Jira.

If the credentials are in `.env.local` but the pointer file is not there yet,
Crucible still treats Jira as the intended host and says what is missing rather
than showing an empty board.

## What the board shows

- Open means the ticket's **status category is not done**. Not a status name:
  a Jira project can have a dozen done-category statuses called Closed,
  Withdrawn or Resolved, and comparing names would list them forever.
- The project's open tickets, most recently updated first, up to a hundred.
- Grouped by claim, in this order: assigned to you, unclaimed, already picked
  up, then assigned to others. A teammate's ticket is never hidden, only last;
  the board opens on yours and the unclaimed ones and widens to everyone's in
  one click.
- "Already picked up" on a Jira board means a session in this workspace was
  started on that ticket. Pull requests are not read this round.
- Rows and the reading pane name each ticket by its key (`EK-341`), which is
  also what ⌘C copies and what a started session's first message carries.

Grouping compares Atlassian account ids, never display names, so two teammates
with the same name stay two people. No account id, email or token ever reaches
the window: what it shows is display names.

## When something is missing

The board says so, in the pane where it would otherwise show a ticket: a
heading that Jira is not set up in this workspace yet, then every missing piece
by its exact name with a sentence saying where it goes. Missing keys and a
missing pointer file are listed together, so one look is enough.

A key whose value cannot be used counts as missing too: an empty value, a
pointer file that will not parse, a `JIRA_BASE_URL` without its scheme. The
sentence beside the name shows the shape it wants.

Fix the files and press ⌘I again. Opening the board re-reads them; there is
nothing to restart and no setting to flip.

If the configuration is complete but Jira refuses or cannot be reached, the
board says that instead, and names the file to look at:

- rejected credentials point you at `JIRA_API_TOKEN` in `.env.local`, which is
  usually a token that expired or belongs to another account than `JIRA_EMAIL`;
- an invisible project points you at `projectKey` in `.crucible/jira.json`,
  which is usually a typo or a project this account cannot see;
- otherwise it says Jira could not be reached, which is `JIRA_BASE_URL` or the
  network.

## A worked example

```bash
# 1. the ignore, before the token
git check-ignore -q .env.local || echo '.env.local' >> .gitignore

# 2. the credentials, copied from the sibling repository the user named
grep -E '^JIRA_(BASE_URL|EMAIL|API_TOKEN)=' ../other-work-repo/.env.local >> .env.local

# 3. the pointer, which is the file you commit
mkdir -p .crucible
printf '{ "projectKey": "EK" }\n' > .crucible/jira.json
git add .gitignore .crucible/jira.json
```

Then tell the user to press ⌘I. If the board still says something is missing,
it names it: read that list rather than guessing.
